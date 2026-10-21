import { z } from "zod";
import { IntegrationError } from "../errors";
import type { GoogleOAuth, OAuthTokens, RefreshedTokens } from "../oauth/types";
import { IDENTITY_SCOPES } from "../oauth/scopes";
import { GoogleHttp, type GoogleHttpOptions } from "./http";

/** Google endpoints (overridable for tests against a simulated server). */
export interface GoogleOAuthEndpoints {
  authorize: string;
  token: string;
  userinfo: string;
  revoke: string;
}

export const GOOGLE_OAUTH_ENDPOINTS: GoogleOAuthEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  revoke: "https://oauth2.googleapis.com/revoke",
};

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const UserInfo = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
});

export interface LiveGoogleOAuthOptions extends GoogleHttpOptions {
  clientId: string;
  clientSecret: string;
  endpoints?: Partial<GoogleOAuthEndpoints>;
  now?: () => Date;
}

/**
 * Live Google OAuth (docs/07, ADR 0007/0008): authorization code with PKCE S256, offline access with consent the
 * first time and incremental scopes; identity from userinfo with the fresh access token (direct TLS call to Google,
 * so the id_token signature does not need checking). Unverified addresses are refused.
 */
export class LiveGoogleOAuth implements GoogleOAuth {
  readonly mode = "live" as const;
  private readonly http: GoogleHttp;
  private readonly endpoints: GoogleOAuthEndpoints;
  private readonly now: () => Date;

  constructor(private readonly options: LiveGoogleOAuthOptions) {
    this.http = new GoogleHttp("google-oauth", options);
    this.endpoints = { ...GOOGLE_OAUTH_ENDPOINTS, ...options.endpoints };
    this.now = options.now ?? (() => new Date());
  }

  authorizationUrl(input: {
    state: string;
    scopes: string[];
    redirectUri: string;
    loginHint?: string;
    codeChallenge: string;
  }): string {
    // Identity is read from userinfo: guaranteed here even if a caller passes only feature scopes.
    const scopes = [...new Set([...IDENTITY_SCOPES, ...input.scopes])];
    const url = new URL(this.endpoints.authorize);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    // Consent every time a connection starts: Google only returns a refresh token on consent.
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokens> {
    const token = await this.tokenCall({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }).catch((err: unknown) => {
      // A bad, reused or expired code (or a wrong verifier) is `invalid_grant`: a permanent failure of this
      // callback, not an expired connection.
      if (err instanceof IntegrationError && err.kind === "AuthExpired")
        throw new IntegrationError("Permanent", "google-oauth", err.message, { cause: err });
      throw err;
    });
    if (!token.refresh_token)
      // Without a refresh token the connection would die within the hour: refuse it clearly.
      throw new IntegrationError("Permanent", "google-oauth", "Google did not return a refresh token");
    const info = await this.http.request(UserInfo, {
      url: this.endpoints.userinfo,
      token: () => Promise.resolve(token.access_token),
    });
    if (!info.body) throw new IntegrationError("Permanent", "google-oauth", "empty userinfo response");
    if (info.body.email_verified !== true)
      throw new IntegrationError("Permanent", "google-oauth", "the Google account email is not verified");
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: this.expiresAt(token.expires_in),
      scopes: (token.scope ?? "").split(" ").filter(Boolean),
      externalAccountId: info.body.sub,
      email: info.body.email.toLowerCase(),
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedTokens> {
    const token = await this.tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: this.expiresAt(token.expires_in),
      scopes: token.scope ? token.scope.split(" ").filter(Boolean) : null,
    };
  }

  async revoke(token: string): Promise<void> {
    // 400 = already invalid or revoked: the goal (no valid grant) is met.
    await this.http.request(z.unknown(), {
      method: "POST",
      url: this.endpoints.revoke,
      form: { token },
      allow: [400],
    });
  }

  private async tokenCall(params: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
    const res = await this.http.request(TokenResponse, {
      method: "POST",
      url: this.endpoints.token,
      form: { ...params, client_id: this.options.clientId, client_secret: this.options.clientSecret },
    });
    if (!res.body) throw new IntegrationError("Permanent", "google-oauth", "empty token response");
    return res.body;
  }

  private expiresAt(expiresIn: number): string {
    return new Date(this.now().getTime() + expiresIn * 1000).toISOString();
  }
}
