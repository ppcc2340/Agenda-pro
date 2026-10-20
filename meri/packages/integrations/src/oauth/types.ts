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
  refresh(refreshToken: string): Promise<OAuthTokens>;
  revoke(token: string): Promise<void>;
}

export { CALENDAR_SCOPES } from "./scopes";
