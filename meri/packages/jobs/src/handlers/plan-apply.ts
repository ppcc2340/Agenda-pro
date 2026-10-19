/**
 * Accepting a reschedule proposal and undoing audited actions (ADR 0003 §2 and §4). Shared by the API routes.
 */
import {
  audit,
  currentPlanVersion,
  deleteBlocks,
  expirePending,
  getAuditEntry,
  getBlocksByIds,
  getCommitment,
  getTimeEntry,
  getPreferences,
  getProposal,
  getTask,
  getTasksByIds,
  insertBlocks,
  listOpenTasks,
  lockWorkspace,
  proposalHashExists,
  reopenProposal,
  updateTimeEntry,
  resolveProposal,
  setPlanVersion,
  softDeleteTask,
  updateBlock,
  updateCommitment,
  updateTask,
  withWorkspace,
  type AuditEntry,
  type ScheduleBlockView,
  type TaskStatus,
  type UserId,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { z } from "zod";
import type { HandlerDeps } from "./context";
import { writeBlocksToCalendar } from "./meri-calendar";
import { ReschedulePayloadSchema } from "./replan";

export class PlanApplyError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "VALIDATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PlanApplyError";
  }
}

const serializeBlock = (b: ScheduleBlockView) => ({
  id: b.id,
  taskId: b.taskId,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  pinned: b.pinned,
  reason: b.reason,
  calendarEventId: b.calendarEventId,
  planVersion: b.planVersion,
});

async function titlesFor(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  taskIds: string[],
): Promise<Map<string, string>> {
  const tasks = await getTasksByIds(tx, workspaceId, [...new Set(taskIds)]);
  return new Map([...tasks.values()].map((t) => [t.id, t.title]));
}

export interface AcceptResult {
  planVersion: number;
  added: number;
  removed: number;
  auditId: string;
  calendar: { created: number; deleted: number } | null;
}

/** Applies a pending reschedule proposal; `basePlanVersion` must still be the current plan (else CONFLICT). */
export async function acceptProposal(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  proposalId: string,
  actorUserId: UserId,
): Promise<AcceptResult> {
  const now = deps.now();
  const applied = await withWorkspace(deps.db, workspaceId, async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const proposal = await getProposal(tx, workspaceId, proposalId);
    if (!proposal || proposal.kind !== "reschedule")
      throw new PlanApplyError("NOT_FOUND", "Proposal not found.");
    if (proposal.status !== "pending") throw new PlanApplyError("CONFLICT", "Proposal is no longer pending.");
    const parsed = ReschedulePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) throw new PlanApplyError("VALIDATION_FAILED", "Proposal payload is not readable.");
    const payload = parsed.data;
    const base = await currentPlanVersion(tx, workspaceId);
    if (payload.basePlanVersion !== base) {
      throw new PlanApplyError(
        "CONFLICT",
        "The plan changed since this proposal was computed. Replan first.",
      );
    }
    const planVersion = base + 1;
    const removeIds = [...payload.removed.map((r) => r.blockId), ...payload.moved.map((m) => m.blockId)];
    // Every block the diff touches must still exist, unchanged and unpinned; otherwise the diff is stale.
    const current = new Map((await getBlocksByIds(tx, workspaceId, removeIds)).map((b) => [b.id, b]));
    const intervals = [
      ...payload.removed.map((r) => ({ id: r.blockId, startsAt: r.startsAt, endsAt: r.endsAt })),
      ...payload.moved.map((m) => ({ id: m.blockId, startsAt: m.from.startsAt, endsAt: m.from.endsAt })),
    ];
    for (const i of intervals) {
      const b = current.get(i.id);
      if (
        !b ||
        b.pinned ||
        b.completedAt ||
        b.startsAt.toISOString() !== i.startsAt ||
        b.endsAt.toISOString() !== i.endsAt
      ) {
        throw new PlanApplyError(
          "CONFLICT",
          "A block in this proposal changed (pinned, done or moved). Replan first.",
        );
      }
    }
    await setPlanVersion(tx, workspaceId, planVersion);
    const removed = await deleteBlocks(tx, workspaceId, removeIds);
    const open = new Set<string>((await listOpenTasks(tx, workspaceId)).map((t) => t.id));
    const toInsert = [
      ...payload.added.map((b) => ({
        taskId: b.taskId,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        pinned: b.pinned,
        reasons: b.reasons,
      })),
      ...payload.moved.map((m) => ({
        taskId: m.taskId,
        startsAt: m.to.startsAt,
        endsAt: m.to.endsAt,
        pinned: false,
        reasons: m.reasons,
      })),
    ].filter((b) => open.has(b.taskId));
    const created = await insertBlocks(
      tx,
      workspaceId,
      toInsert.map((b) => ({
        taskId: b.taskId,
        startsAt: new Date(b.startsAt),
        endsAt: new Date(b.endsAt),
        pinned: b.pinned,
        reason: b.reasons,
      })),
      planVersion,
      now,
    );
    const resolved = await resolveProposal(
      tx,
      workspaceId,
      proposalId,
      { status: "confirmed", action: "accepted" },
      now,
    );
    if (!resolved) throw new PlanApplyError("CONFLICT", "Proposal is no longer pending.");
    const auditId = await audit(
      tx,
      { workspaceId, actor: "user", actorUserId },
      {
        action: "plan.accepted",
        entityType: "proposal",
        entityId: proposalId,
        reason: `proposal:${proposalId}`,
        before: { planVersion: base, removed: removed.map(serializeBlock) },
        after: { planVersion, added: created.map(serializeBlock), proposalId },
      },
    );
    const titles = await titlesFor(
      tx,
      workspaceId,
      created.map((b) => b.taskId),
    );
    return { planVersion, created, removed, auditId, titles };
  });
  // Accepted plans always reach the calendar (ADR 0003 §3), after commit.
  const cal = await writeBlocksToCalendar(deps, workspaceId, {
    create: applied.created,
    remove: applied.removed,
    titles: applied.titles,
  });
  return {
    planVersion: applied.planVersion,
    added: applied.created.length,
    removed: applied.removed.length,
    auditId: applied.auditId,
    calendar: cal.accountId ? { created: cal.created, deleted: cal.deleted } : null,
  };
}

export const UNDOABLE_ACTIONS = [
  "plan.generated",
  "plan.accepted",
  "task.completed",
  "task.created",
  "block.pinned",
  "block.completed",
  "commitment.autoconfirmed",
  "time.approved",
] as const;

export interface UndoResult {
  auditId: string;
  action: string;
  calendar: { created: number; deleted: number } | null;
}

const SerializedBlockSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  pinned: z.boolean(),
  reason: z.array(z.object({ code: z.string(), params: z.record(z.unknown()) })),
  calendarEventId: z.string().nullable(),
  planVersion: z.number(),
});
const PlanAuditSchema = z.object({
  planVersion: z.number().int().nonnegative(),
  added: z.array(SerializedBlockSchema).optional(),
  removed: z.array(SerializedBlockSchema).optional(),
});

async function undoPlan(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entry: AuditEntry,
  now: Date,
): Promise<{ create: ScheduleBlockView[]; remove: ScheduleBlockView[] }> {
  const afterParsed = PlanAuditSchema.safeParse(entry.after);
  const beforeParsed = PlanAuditSchema.safeParse(entry.before);
  if (!afterParsed.success || !beforeParsed.success)
    throw new PlanApplyError("VALIDATION_FAILED", "Entry has no restorable plan state.");
  const after = afterParsed.data;
  const before = beforeParsed.data;
  const current = await currentPlanVersion(tx, workspaceId);
  if (after.planVersion !== current) {
    throw new PlanApplyError("CONFLICT", "A newer plan exists; undo the most recent plan change first.");
  }
  await setPlanVersion(tx, workspaceId, before.planVersion);
  const remove = await deleteBlocks(
    tx,
    workspaceId,
    (after.added ?? []).map((b) => b.id),
  );
  const open = new Set<string>((await listOpenTasks(tx, workspaceId)).map((t) => t.id));
  const restored = (before.removed ?? []).filter((b) => open.has(b.taskId));
  const create = await insertBlocks(
    tx,
    workspaceId,
    restored.map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startsAt: new Date(b.startsAt),
      endsAt: new Date(b.endsAt),
      pinned: b.pinned,
      reason: b.reason,
    })),
    before.planVersion,
    now,
  );
  await expirePending(tx, workspaceId, "reschedule", now);
  // Restored blocks get a fresh calendar event only if they had one before.
  const hadEvent = new Set(restored.filter((b) => b.calendarEventId).map((b) => b.id));
  return { create: create.filter((b) => hadEvent.has(b.id)), remove };
}

async function undoTaskStatus(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entry: AuditEntry,
  now: Date,
): Promise<void> {
  const before = entry.before as { status?: TaskStatus; completedAt?: string | null } | null;
  if (!entry.entityId || !before?.status)
    throw new PlanApplyError("VALIDATION_FAILED", "Entry has no restorable state.");
  const task = await getTask(tx, workspaceId, entry.entityId);
  if (!task) throw new PlanApplyError("CONFLICT", "The task no longer exists.");
  await updateTask(tx, workspaceId, entry.entityId, { status: before.status }, now);
}

/**
 * Append-only undo (D-023): inserts `<action>.undone` with `undo_of_audit_id` and applies the compensation.
 * Already-undone entries and compensations themselves are rejected.
 */
export async function undoAuditEntry(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  auditId: string,
  actorUserId: UserId,
): Promise<UndoResult> {
  const now = deps.now();
  const done = await withWorkspace(deps.db, workspaceId, async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const entry = await getAuditEntry(tx, workspaceId, auditId);
    if (!entry) throw new PlanApplyError("NOT_FOUND", "Audit entry not found.");
    if (entry.undoOfAuditId)
      throw new PlanApplyError("VALIDATION_FAILED", "A compensation cannot be undone.");
    if (entry.undoneAt) throw new PlanApplyError("CONFLICT", "This action was already undone.");
    let calendar: { create: ScheduleBlockView[]; remove: ScheduleBlockView[] } = { create: [], remove: [] };
    switch (entry.action) {
      case "plan.generated":
      case "plan.accepted":
        calendar = await undoPlan(tx, workspaceId, entry, now);
        break;
      case "task.completed":
        await undoTaskStatus(tx, workspaceId, entry, now);
        break;
      case "task.created": {
        if (!entry.entityId) throw new PlanApplyError("VALIDATION_FAILED", "Entry has no task.");
        const deleted = await softDeleteTask(tx, workspaceId, entry.entityId, now);
        if (!deleted) throw new PlanApplyError("CONFLICT", "The task no longer exists.");
        break;
      }
      case "block.pinned": {
        const before = entry.before as { pinned?: boolean } | null;
        if (!entry.entityId || before?.pinned === undefined)
          throw new PlanApplyError("VALIDATION_FAILED", "Entry has no restorable state.");
        const block = await updateBlock(tx, workspaceId, entry.entityId, { pinned: before.pinned });
        if (!block) throw new PlanApplyError("CONFLICT", "The block no longer exists.");
        break;
      }
      case "commitment.autoconfirmed": {
        const before = entry.before as { proposalId?: string } | null;
        if (!entry.entityId || !before?.proposalId)
          throw new PlanApplyError("VALIDATION_FAILED", "Entry has no restorable state.");
        const current = await getCommitment(tx, workspaceId, entry.entityId);
        if (!current) throw new PlanApplyError("CONFLICT", "The commitment no longer exists.");
        // Once the user acted on it (fulfilled, dismissed, edited status) the auto-confirmation is history.
        if (current.status !== "confirmed")
          throw new PlanApplyError("CONFLICT", "The commitment was already handled; nothing to undo.");
        if (await proposalHashExists(tx, workspaceId, current.dedupeHash, "pending"))
          throw new PlanApplyError("CONFLICT", "A pending proposal for this commitment already exists.");
        await updateCommitment(tx, workspaceId, entry.entityId, { status: "proposed" }, now);
        await reopenProposal(tx, workspaceId, before.proposalId);
        break;
      }
      case "time.approved": {
        if (!entry.entityId) throw new PlanApplyError("VALIDATION_FAILED", "Entry has no time entry.");
        const current = await getTimeEntry(tx, workspaceId, entry.entityId);
        if (!current) throw new PlanApplyError("CONFLICT", "The time entry no longer exists.");
        if (current.status !== "approved")
          throw new PlanApplyError("CONFLICT", "The time entry was already changed; nothing to undo.");
        await updateTimeEntry(tx, workspaceId, entry.entityId, { status: "suggested", approvedAt: null });
        break;
      }
      case "block.completed": {
        const after = entry.after as {
          taskCompleted?: boolean;
          taskId?: string;
          previousStatus?: TaskStatus;
        } | null;
        if (!entry.entityId) throw new PlanApplyError("VALIDATION_FAILED", "Entry has no block.");
        const block = await updateBlock(tx, workspaceId, entry.entityId, { completedAt: null });
        if (!block) throw new PlanApplyError("CONFLICT", "The block no longer exists.");
        if (after?.taskCompleted && after.taskId && after.previousStatus) {
          await updateTask(tx, workspaceId, after.taskId, { status: after.previousStatus }, now);
        }
        break;
      }
      default:
        throw new PlanApplyError("VALIDATION_FAILED", `Action ${entry.action} cannot be undone.`);
    }
    const compensationId = await audit(
      tx,
      { workspaceId, actor: "user", actorUserId },
      {
        action: `${entry.action}.undone`,
        entityType: entry.entityType ?? undefined,
        entityId: entry.entityId,
        reason: `undo:${entry.id}`,
        before: entry.after,
        after: entry.before,
        undoOfAuditId: entry.id,
      },
    );
    const titles = await titlesFor(
      tx,
      workspaceId,
      calendar.create.map((b) => b.taskId),
    );
    const prefs = await getPreferences(tx, workspaceId);
    return {
      compensationId,
      action: entry.action,
      calendar,
      titles,
      autonomy: prefs?.autonomy ?? "suggest_only",
    };
  });
  let calendar: UndoResult["calendar"] = null;
  if (done.calendar.create.length > 0 || done.calendar.remove.length > 0) {
    const r = await writeBlocksToCalendar(deps, workspaceId, { ...done.calendar, titles: done.titles });
    calendar = r.accountId ? { created: r.created, deleted: r.deleted } : null;
  }
  return { auditId: done.compensationId, action: done.action, calendar };
}
