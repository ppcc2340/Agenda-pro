/**
 * Purge of indexed mail (D-036): used by disconnect ("desconectar y purgar") and by data.retention. Order matters:
 * proposed commitments go, confirmed ones lose their thread link, pending proposals from those threads expire,
 * and only then the thread rows are deleted. Nothing the user confirmed is lost.
 */
import {
  audit,
  detachCommitmentsFromThreads,
  deleteThreadsByIds,
  expireProposalsForThreads,
  getEntitlementRetentionDays,
  getPreferences,
  listThreadIdsForAccount,
  listThreadIdsOlderThan,
  purgeProposedCommitments,
  withWorkspace,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export interface PurgeResult {
  threads: number;
  proposedCommitments: number;
  detachedCommitments: number;
  expiredProposals: number;
}

export async function purgeThreads(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  threadIds: string[],
  now: Date,
): Promise<PurgeResult> {
  if (threadIds.length === 0)
    return { threads: 0, proposedCommitments: 0, detachedCommitments: 0, expiredProposals: 0 };
  const proposedCommitments = await purgeProposedCommitments(tx, workspaceId, threadIds);
  const detachedCommitments = await detachCommitmentsFromThreads(tx, workspaceId, threadIds, now);
  const expiredProposals = await expireProposalsForThreads(tx, workspaceId, threadIds, now);
  const threads = await deleteThreadsByIds(tx, workspaceId, threadIds);
  return { threads, proposedCommitments, detachedCommitments, expiredProposals };
}

/** Everything indexed for one mail account (disconnect). */
export async function purgeAccountMail(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  now: Date,
): Promise<PurgeResult> {
  const ids = await listThreadIdsForAccount(tx, workspaceId, accountId);
  return purgeThreads(tx, workspaceId, ids, now);
}

/** data.retention: threads older than min(preferences.retention_days, entitlement cap) are purged in batches. */
export async function applyMailRetention(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  options: { maxRetentionDays: number },
): Promise<PurgeResult & { retentionDays: number }> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    const planCap = await getEntitlementRetentionDays(tx, workspaceId);
    const retentionDays = Math.max(
      1,
      Math.min(prefs?.retentionDays ?? planCap, planCap, options.maxRetentionDays),
    );
    const before = new Date(now.getTime() - retentionDays * 86_400_000);
    const ids = await listThreadIdsOlderThan(tx, workspaceId, before);
    const result = await purgeThreads(tx, workspaceId, ids, now);
    if (result.threads > 0)
      await audit(
        tx,
        { workspaceId, actor: "system" },
        {
          action: "mail.retention_applied",
          entityType: "workspace",
          entityId: workspaceId,
          reason: `older than ${String(retentionDays)} days`,
          after: { ...result },
        },
      );
    return { ...result, retentionDays };
  });
}
