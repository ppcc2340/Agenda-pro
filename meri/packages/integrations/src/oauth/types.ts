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
  /** Builds the authorization URL; `state` must be stored by the caller and verified on callback. */
  authorizationUrl(input: {
    state: string;
    scopes: string[];
    redirectUri: string;
    loginHint?: string;
  }): string;
  /** Exchanges the authorization code. Throws IntegrationError(Permanent) on invalid code. */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  revoke(token: string): Promise<void>;
}

export { CALENDAR_SCOPES } from "./scopes";
