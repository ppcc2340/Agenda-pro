import { createHash } from "node:crypto";
import { IntegrationError } from "../errors";
import type { GoogleOAuth, OAuthTokens } from "../oauth/types";

/**
 * Fake Google OAuth: the "consent screen" is the callback itself. Codes are minted by `authorizationUrl` and are
 * single-use, bound to the scopes, the account email (login hint) and the PKCE challenge, so the callback path
 * exercises the same state/code/verifier checks as the live flow.
 */
export class FakeGoogleOAuth implements GoogleOAuth {
  readonly mode = "fake" as const;
  private readonly codes = new Map<string, { scopes: string[]; email: string; challenge: string }>();
  private counter = 0;
  readonly revoked: string[] = [];
  constructor(
    private readonly now: () => Date,
    private readonly defaultEmail = "demo@meri.local",
  ) {}

  authorizationUrl(input: {
    state: string;
    scopes: string[];
    redirectUri: string;
    loginHint?: string;
    codeChallenge: string;
  }): string {
    const code = `fake-code-${String(++this.counter)}`;
    this.codes.set(code, {
      scopes: input.scopes,
      email: input.loginHint ?? this.defaultEmail,
      challenge: input.codeChallenge,
    });
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", input.scopes.join(" "));
    return url.toString();
  }

  exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokens> {
    const entry = this.codes.get(input.code);
    if (!entry)
      return Promise.reject(
        new IntegrationError("Permanent", "google-oauth", "invalid or already used authorization code"),
      );
    // Like Google: the code is consumed even when the verifier is wrong.
    this.codes.delete(input.code);
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (challenge !== entry.challenge)
      return Promise.reject(new IntegrationError("Permanent", "google-oauth", "PKCE verifier does not match"));
    return Promise.resolve(this.tokens(entry.email, entry.scopes));
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    if (this.revoked.includes(refreshToken)) {
      return Promise.reject(new IntegrationError("AuthExpired", "google-oauth", "refresh token revoked"));
    }
    const email = refreshToken.split("|")[1] ?? this.defaultEmail;
    return Promise.resolve(this.tokens(email, []));
  }

  revoke(token: string): Promise<void> {
    this.revoked.push(token);
    return Promise.resolve();
  }

  private tokens(email: string, scopes: string[]): OAuthTokens {
    const n = String(++this.counter);
    return {
      accessToken: `fake-access-${n}`,
      refreshToken: `fake-refresh-${n}|${email}`,
      expiresAt: new Date(this.now().getTime() + 3600_000).toISOString(),
      scopes,
      externalAccountId: `fake-sub-${email}`,
      email,
    };
  }
}
