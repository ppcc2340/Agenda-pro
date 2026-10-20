/**
 * Value events at the source of each verifiable fact (D-063, F-12). Every route, job and the demo seed records
 * value through these helpers, so the report counts exactly what happened and the same rules hold everywhere.
 */
import {
  auditActionExists,
  deleteValueEvent,
  recordValueEvent,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";

/** Inferred sources (D-042): only time Meri suggested counts as "recovered"; manual entries were never lost. */
const INFERRED_SOURCES = new Set(["calendar_event", "schedule_block"]);

export async function recordTimeRecovered(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entry: { id: string; minutes: number; sourceType: string },
  now: Date,
): Promise<boolean> {
  if (!INFERRED_SOURCES.has(entry.sourceType) || entry.minutes <= 0) return false;
  return recordValueEvent(
    tx,
    workspaceId,
    {
      type: "untracked_time_recovered",
      entityType: "time_entry",
      entityId: entry.id,
      quantity: entry.minutes,
      method: "inferred_time_approved",
    },
    now,
  );
}

/** Compensation when an approval is undone or rejected ([M7]): the entry stops counting. */
export async function forgetTimeRecovered(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entryId: string,
): Promise<void> {
  await deleteValueEvent(tx, workspaceId, "untracked_time_recovered", entryId);
}

/**
 * A commitment counts as saved when it is fulfilled after a Meri follow-up was saved for it, or on time against a
 * known due date. A late fulfilment without a follow-up, or one without a due date, proves nothing: no event.
 */
export async function recordCommitmentSaved(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  commitment: { id: string; dueAt: Date | null },
  now: Date,
): Promise<{ recorded: boolean; onTime: boolean }> {
  const onTime = commitment.dueAt !== null && now.getTime() <= commitment.dueAt.getTime();
  const afterFollowup = await auditActionExists(tx, workspaceId, "followup.draft_saved", commitment.id);
  if (!afterFollowup && !onTime) return { recorded: false, onTime };
  const recorded = await recordValueEvent(
    tx,
    workspaceId,
    {
      type: "commitment_saved",
      entityType: "commitment",
      entityId: commitment.id,
      quantity: 1,
      method: afterFollowup ? "commitment_fulfilled_after_followup" : "commitment_fulfilled_on_time",
    },
    now,
  );
  return { recorded, onTime };
}

export async function forgetCommitmentSaved(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  commitmentId: string,
): Promise<void> {
  await deleteValueEvent(tx, workspaceId, "commitment_saved", commitmentId);
}

/** A deadline risk flagged before it was missed (planner on a task, follow-up scan on a third-party commitment). */
export async function recordDeadlineRisk(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entity: { type: "task" | "commitment"; id: string },
  now: Date,
): Promise<boolean> {
  return recordValueEvent(
    tx,
    workspaceId,
    {
      type: "deadline_risk_flagged",
      entityType: entity.type,
      entityId: entity.id,
      quantity: 1,
      method: entity.type === "task" ? "task_flagged_at_risk_by_planner" : "third_party_commitment_overdue",
    },
    now,
  );
}
