import { IntegrationError } from "../errors";
import type { GoogleOAuth, OAuthTokens } from "../oauth/types";

/**
 * Fake Google OAuth: the "consent screen" is the callback itself. Codes are minted by `authorizationUrl` and are
 * single-use, bound to the scopes and the account email (login hint), so the callback path exercises the same
 * state/code verification as the live flow.
 */
export class FakeGoogleOAuth implements GoogleOAuth {
  readonly mode = "fake" as const;
  private readonly codes = new Map<string, { scopes: string[]; email: string }>();
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
  }): string {
    const code = `fake-code-${String(++this.counter)}`;
    this.codes.set(code, { scopes: input.scopes, email: input.loginHint ?? this.defaultEmail });
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", input.scopes.join(" "));
    return url.toString();
  }

  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    const entry = this.codes.get(input.code);
    if (!entry)
      return Promise.reject(
        new IntegrationError("Permanent", "google-oauth", "invalid or already used authorization code"),
      );
    this.codes.delete(input.code);
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
