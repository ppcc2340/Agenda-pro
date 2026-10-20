import type { FastifyBaseLogger } from "fastify";
import type { KeyProvider } from "@meri/config/crypto";
import { listIntegrationAccounts, withWorkspace, type Db, type WorkspaceId } from "@meri/db";
import type { GoogleOAuth } from "@meri/integrations";
import { readTokens } from "@meri/jobs";

/**
 * Reads every connection's tokens before they are wiped, so they can be revoked at the provider after commit.
 * A token that cannot be decrypted is skipped (it is wiped anyway).
 */
export async function collectTokensToRevoke(
  deps: { db: Db; keys: KeyProvider },
  workspaceId: WorkspaceId,
  logger: FastifyBaseLogger,
): Promise<{ accountId: string; token: string }[]> {
  const accounts = await withWorkspace(deps.db, workspaceId, (tx) => listIntegrationAccounts(tx, workspaceId));
  const out: { accountId: string; token: string }[] = [];
  for (const account of accounts) {
    try {
      const tokens = await readTokens(deps, workspaceId, account.id);
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token) out.push({ accountId: account.id, token });
    } catch (err) {
      logger.warn({ err, accountId: account.id }, "tokens unreadable before deletion; wiped without revocation");
    }
  }
  return out;
}

/** Best-effort revocation at the provider (never blocks the deletion); each outcome is logged. */
export async function revokeAtProvider(
  oauth: GoogleOAuth,
  items: { accountId: string; token: string }[],
  logger: FastifyBaseLogger,
): Promise<number> {
  let revoked = 0;
  for (const item of items) {
    try {
      await oauth.revoke(item.token);
      revoked++;
    } catch (err) {
      logger.warn({ err, accountId: item.accountId }, "provider revocation failed; the token stays unusable here");
    }
  }
  return revoked;
}

