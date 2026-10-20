import {
  getSubscription,
  purgeWorkspace,
  PURGE_AFTER_DAYS,
  withWorkspace,
  workspaceDeletedAt,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export interface AccountPurgeResult {
  status: "purged" | "not_eligible" | "already_purged";
  rowsDeleted: number;
  customerDeleted: boolean;
}

/**
 * `data.delete_account` (F-16, ADR 0007). Runs with the application role: the purge itself is the SECURITY DEFINER
 * `purge_workspace()`, which re-checks the 30-day window. The provider customer is erased first because its id
 * lives in the rows the purge removes; both steps are idempotent, so a retry after any failure completes the job.
 */
export async function purgeDeletedAccount(
  deps: Pick<HandlerDeps, "db" | "integrations" | "now" | "logger">,
  workspaceId: WorkspaceId,
): Promise<AccountPurgeResult> {
  const deletedAt = await workspaceDeletedAt(deps.db, workspaceId);
  if (deletedAt === undefined) return { status: "already_purged", rowsDeleted: 0, customerDeleted: false };
  const cutoff = deps.now().getTime() - PURGE_AFTER_DAYS * 86_400_000;
  if (!deletedAt || deletedAt.getTime() > cutoff)
    return { status: "not_eligible", rowsDeleted: 0, customerDeleted: false };
  const sub = await withWorkspace(deps.db, workspaceId, (tx) => getSubscription(tx, workspaceId));
  let customerDeleted = false;
  if (sub?.stripeCustomerId) {
    await deps.integrations.billing.deleteCustomer(sub.stripeCustomerId);
    customerDeleted = true;
  }
  const rowsDeleted = await purgeWorkspace(deps.db, workspaceId);
  deps.logger.info({ workspaceId, rowsDeleted, customerDeleted }, "account purged");
  return { status: "purged", rowsDeleted, customerDeleted };
}
