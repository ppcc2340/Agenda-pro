import { z } from "zod";
import { localDateKey } from "@meri/core";
import { decryptEnvelopeToString, parseEnvelope } from "@meri/config/crypto";
import {
  audit,
  getEncryptedTokens,
  getIntegrationAccount,
  getPreferences,
  insertNotification,
  markIntegrationNeedsReauth,
  setMeriCalendarId,
  swapEncryptedTokens,
  withWorkspace,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { IntegrationError, type GoogleAccountRef, type OAuthTokens } from "@meri/integrations";
import { encryptTokens, tokenAad } from "./tokens";
import type { HandlerDeps } from "./handlers/context";

/** Refresh this long before expiry so a request never starts with a token about to die. */
const REFRESH_MARGIN_MS = 60_000;

/** The stored token blob, validated (it is decrypted from the database, still worth checking). */
export const StoredTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.string(),
  scopes: z.array(z.string()),
  externalAccountId: z.string(),
  email: z.string(),
});

/**
 * The grant behind these tokens is gone (`invalid_grant`, or no refresh token). Carries the ciphertext that failed
 * so `markNeedsReauth` only flags the connection if it still holds those exact tokens.
 */
export class TokenRevokedError extends IntegrationError {
  constructor(
    readonly ciphertext: string,
    cause?: unknown,
  ) {
    super("AuthExpired", "google-oauth", "the Google grant was revoked or expired", { cause });
  }
}

/** One refresh in flight per connection and process (ADR 0008). */
const inflight = new Map<string, Promise<{ tokens: OAuthTokens; ciphertext: string }>>();

type AccessDeps = Pick<HandlerDeps, "db" | "keys" | "integrations" | "now">;

async function readStored(deps: AccessDeps, workspaceId: WorkspaceId, accountId: string) {
  const row = await withWorkspace(deps.db, workspaceId, (tx) =>
    getEncryptedTokens(tx, workspaceId, accountId),
  );
  if (!row) return null;
  // Decrypt the very ciphertext that was read, so the compare-and-swap compares against what we hold.
  const json = await decryptEnvelopeToString(
    deps.keys,
    row.encryptedTokens,
    tokenAad(workspaceId, accountId),
  );
  return { tokens: StoredTokens.parse(JSON.parse(json)), ciphertext: row.encryptedTokens };
}

/**
 * Per-connection access for the Google adapters (ADR 0008, D-097): decrypts once, hands out the access token while
 * it is valid, refreshes outside any transaction (a single refresh in flight per connection), stores the renewed
 * tokens with compare-and-swap keeping the stored identity and scopes, and rereads when another process won the
 * race. Throws `TokenRevokedError` when the grant is gone; it never changes the connection's status itself.
 */
export async function googleAccess(
  deps: AccessDeps,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<GoogleAccountRef | null> {
  const [account, stored] = await Promise.all([
    withWorkspace(deps.db, workspaceId, (tx) => getIntegrationAccount(tx, workspaceId, accountId)),
    readStored(deps, workspaceId, accountId),
  ]);
  if (!account || !stored) return null;
  let current = stored;

  const refresh = async (): Promise<{ tokens: OAuthTokens; ciphertext: string }> => {
    const { tokens, ciphertext } = current;
    if (!tokens.refreshToken) throw new TokenRevokedError(ciphertext);
    let renewed;
    try {
      renewed = await deps.integrations.oauth.refresh(tokens.refreshToken);
    } catch (err) {
      if (err instanceof IntegrationError && err.kind === "AuthExpired")
        throw new TokenRevokedError(ciphertext, err);
      throw err;
    }
    const merged: OAuthTokens = {
      ...tokens,
      accessToken: renewed.accessToken,
      expiresAt: renewed.expiresAt,
      refreshToken: renewed.refreshToken ?? tokens.refreshToken,
      scopes: renewed.scopes ?? tokens.scopes,
    };
    const next = await encryptTokens(deps, workspaceId, accountId, merged);
    const swapped = await withWorkspace(deps.db, workspaceId, (tx) =>
      swapEncryptedTokens(tx, workspaceId, accountId, {
        expected: ciphertext,
        next,
        keyId: parseEnvelope(next).keyId,
      }),
    );
    if (swapped) return { tokens: merged, ciphertext: next };
    // Another worker refreshed (or the user reconnected) first: use what is stored now.
    const again = await readStored(deps, workspaceId, accountId);
    if (!again) throw new IntegrationError("Permanent", "google-oauth", "the connection was removed");
    return again;
  };

  return {
    email: current.tokens.email,
    meriCalendarId: account.meriCalendarId,
    rememberMeriCalendar: (calendarId) =>
      withWorkspace(deps.db, workspaceId, (tx) => setMeriCalendarId(tx, workspaceId, accountId, calendarId)),
    accessToken: async (options) => {
      const fresh = Date.parse(current.tokens.expiresAt) - deps.now().getTime() > REFRESH_MARGIN_MS;
      if (fresh && !options?.forceRefresh) return current.tokens.accessToken;
      const key = `${workspaceId}:${accountId}`;
      let pending = inflight.get(key);
      if (!pending) {
        pending = refresh().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      current = await pending;
      return current.tokens.accessToken;
    },
  };
}

/**
 * The single place that turns an expired grant into `needs_reauth` + audit (jobs and API). With a
 * `TokenRevokedError` the update only applies if the connection still holds the tokens that failed.
 */
export async function markNeedsReauth(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  err: IntegrationError,
  now: Date = new Date(),
): Promise<boolean> {
  const before = await getIntegrationAccount(tx, workspaceId, accountId);
  const marked = await markIntegrationNeedsReauth(
    tx,
    workspaceId,
    accountId,
    err instanceof TokenRevokedError ? err.ciphertext : null,
  );
  if (marked)
    await audit(
      tx,
      { workspaceId, actor: "system" },
      {
        action: "integration.needs_reauth",
        entityType: "integration_account",
        entityId: accountId,
        // Fixed codes only (provider + status + reason), never response text (ADR 0008).
        reason: `${err.kind}: ${err.message.slice(0, 120)}`,
      },
    );
  // One notice per loss of access (D-114): the inbox and, under the default email preference, an email. Ids only.
  if (marked && before && before.status !== "needs_reauth") {
    const timezone = (await getPreferences(tx, workspaceId))?.timezone ?? "UTC";
    await insertNotification(
      tx,
      workspaceId,
      {
        kind: "integration",
        template: "integration.needs_reauth",
        title: "Tu conexión con Google necesita atención",
        body: "Vuelve a conectar Google en el Centro de control para que Meri siga leyendo tu calendario y tu correo.",
        params: {},
        refs: [{ type: "integration_account", id: accountId }],
        day: localDateKey(now.getTime(), timezone),
      },
      now,
    );
  }
  return marked;
}
