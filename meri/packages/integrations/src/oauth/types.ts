/** OAuth for Google (docs/07). The live adapter talks to Google; the fake validates `state` exactly the same way. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO
  scopes: string[];
  /** Google account identity (sub) and email. */
  externalAccountId: string;
  email: string;
}

/**
 * A refresh only renews the access token: the identity and the stored refresh token are the caller's (Google rotates
 * the refresh token rarely, `null` = keep the stored one; `scopes` null = unchanged).
 */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO
  scopes: string[] | null;
}

export interface GoogleOAuth {
  readonly mode: "fake" | "live";
  /**
   * Builds the authorization URL; `state` must be stored by the caller and verified on callback. PKCE is mandatory
   * (ADR 0007): `codeChallenge` = base64url(SHA-256(verifier)), method S256.
   */
  authorizationUrl(input: {
    state: string;
    scopes: string[];
    redirectUri: string;
    loginHint?: string;
    codeChallenge: string;
  }): string;
  /** Exchanges the authorization code with its PKCE verifier. Throws IntegrationError(Permanent) on invalid code. */
  exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokens>;
  /** Throws IntegrationError(AuthExpired) when the grant was revoked or expired (`invalid_grant`). */
  refresh(refreshToken: string): Promise<RefreshedTokens>;
  revoke(token: string): Promise<void>;
}

export { CALENDAR_SCOPES } from "./scopes";

/**
 * A connected Google account as the live adapters see it (ADR 0008): the address plus a token supplier that
 * refreshes when needed. `forceRefresh` renews even an unexpired token (used once after a 401). Fakes ignore it.
 */
export interface GoogleAccountRef {
  email: string;
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}
