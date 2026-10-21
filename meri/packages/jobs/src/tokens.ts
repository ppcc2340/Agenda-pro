import { decryptEnvelopeToString, encryptEnvelope } from "@meri/config/crypto";
import { getEncryptedTokens, withWorkspace, type WorkspaceId } from "@meri/db";
import type { OAuthTokens } from "@meri/integrations";
import type { HandlerDeps } from "./handlers/context";

/** AAD binds the token blob to its row so ciphertexts cannot be swapped between accounts (docs/06 §2). */
export const tokenAad = (workspaceId: string, accountId: string) =>
  `integration_account:${workspaceId}:${accountId}`;

export async function encryptTokens(
  deps: Pick<HandlerDeps, "keys">,
  workspaceId: string,
  accountId: string,
  tokens: OAuthTokens,
): Promise<string> {
  return encryptEnvelope(deps.keys, JSON.stringify(tokens), tokenAad(workspaceId, accountId));
}

export async function readTokens(
  deps: Pick<HandlerDeps, "db" | "keys">,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<OAuthTokens | null> {
  const row = await withWorkspace(deps.db, workspaceId, (tx) =>
    getEncryptedTokens(tx, workspaceId, accountId),
  );
  if (!row) return null;
  const json = await decryptEnvelopeToString(
    deps.keys,
    row.encryptedTokens,
    tokenAad(workspaceId, accountId),
  );
  return JSON.parse(json) as OAuthTokens;
}
