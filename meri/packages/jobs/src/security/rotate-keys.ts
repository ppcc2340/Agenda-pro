import {
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  rewrapEnvelope,
  type KeyProvider,
} from "@meri/config/crypto";
import { audit, getEncryptedTokens, swapEncryptedTokens, withWorkspace, type Db, type WorkspaceId } from "@meri/db";
import { tokenAad } from "../handlers/calendar-sync";

export interface RotationTarget {
  id: string;
  workspaceId: string;
}

export interface RotationReport {
  scanned: number;
  rotated: number;
  alreadyCurrent: number;
  /** Revoked or never-completed connections: no ciphertext to rotate. */
  empty: number;
  /** Lost compare-and-swap races that succeeded on a retry. */
  retried: number;
  failed: { workspaceId: string; accountId: string; reason: string }[];
}

const MAX_ATTEMPTS = 3;

/**
 * Key rotation for OAuth tokens (ADR 0007). Runs with the application role: each account is updated inside its own
 * workspace transaction (RLS), with a compare-and-swap on the ciphertext so a concurrent token refresh is never
 * overwritten. Default mode re-wraps the data key under the current KEK (the token ciphertext is untouched);
 * `reencrypt` decrypts and encrypts with a brand-new data key (after a suspected DEK exposure). Idempotent:
 * blobs already under the current key are skipped unless `reencrypt`. One audit row per workspace touched.
 */
export async function rotateIntegrationKeys(
  deps: { db: Db; keys: KeyProvider },
  targets: readonly RotationTarget[],
  options: { reencrypt: boolean },
): Promise<RotationReport> {
  const report: RotationReport = { scanned: 0, rotated: 0, alreadyCurrent: 0, empty: 0, retried: 0, failed: [] };
  const perWorkspace = new Map<string, number>();
  for (const target of targets) {
    report.scanned++;
    const ws = target.workspaceId as WorkspaceId;
    try {
      const outcome = await rotateOne(deps, ws, target.id, options.reencrypt);
      if (outcome === "rotated" || outcome === "rotated_after_retry") {
        report.rotated++;
        if (outcome === "rotated_after_retry") report.retried++;
        perWorkspace.set(ws, (perWorkspace.get(ws) ?? 0) + 1);
      } else if (outcome === "current") report.alreadyCurrent++;
      else report.empty++;
    } catch (err) {
      // The reason is the error class/code only: messages could echo key ids, never secrets, but stay terse.
      const reason = err instanceof Error ? ((err as { code?: string }).code ?? err.name) : "unknown";
      report.failed.push({ workspaceId: ws, accountId: target.id, reason });
    }
  }
  for (const [ws, count] of perWorkspace) {
    await withWorkspace(deps.db, ws, (tx) =>
      audit(
        tx,
        { workspaceId: ws as WorkspaceId, actor: "system" },
        {
          action: "security.keys_rotated",
          entityType: "workspace",
          entityId: ws,
          after: { accounts: count, keyId: deps.keys.keyId, mode: options.reencrypt ? "reencrypt" : "rewrap" },
        },
      ),
    );
  }
  return report;
}

async function rotateOne(
  deps: { db: Db; keys: KeyProvider },
  ws: WorkspaceId,
  accountId: string,
  reencrypt: boolean,
): Promise<"rotated" | "rotated_after_retry" | "current" | "empty"> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await withWorkspace(deps.db, ws, async (tx) => {
      const row = await getEncryptedTokens(tx, ws, accountId);
      if (!row?.encryptedTokens.startsWith("v1.")) return "empty" as const;
      if (!reencrypt && parseEnvelope(row.encryptedTokens).keyId === deps.keys.keyId) return "current" as const;
      const aad = tokenAad(ws, accountId);
      const next = reencrypt
        ? await encryptEnvelope(deps.keys, await decryptEnvelope(deps.keys, row.encryptedTokens, aad), aad)
        : await rewrapEnvelope(deps.keys, deps.keys, row.encryptedTokens);
      const swapped = await swapEncryptedTokens(tx, ws, accountId, {
        expected: row.encryptedTokens,
        next,
        keyId: deps.keys.keyId,
      });
      return swapped ? ("swapped" as const) : ("lost" as const);
    });
    if (result === "swapped") return attempt === 1 ? "rotated" : "rotated_after_retry";
    if (result !== "lost") return result;
  }
  throw Object.assign(new Error("token kept changing during rotation"), { code: "CONTENDED" });
}
