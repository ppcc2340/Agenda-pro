/**
 * Value events (D-063, F-12): emitted only where a verifiable fact happens, one per live entity (unique index), and
 * deleted by the compensation of an undo ([M7]). The report labels come from the user's own rows at read time.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { isValueMethod, type ValueEventInput, type ValueEventType, type ValueMethod } from "@meri/core";
import { commitments, tasks, timeEntries, valueEvents } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type ValueEntityType = "commitment" | "task" | "time_entry";

const UNIT: Record<ValueEventType, string> = {
  commitment_saved: "commitments",
  deadline_risk_flagged: "deadlines",
  untracked_time_recovered: "minutes",
};

export interface NewValueEvent {
  type: ValueEventType;
  entityType: ValueEntityType;
  entityId: string;
  /** Minutes for recovered time; 1 for countable events. */
  quantity: number;
  method: ValueMethod;
}

/** Idempotent per (workspace, type, entity): returns false when the entity was already counted. */
export async function recordValueEvent(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  event: NewValueEvent,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .insert(valueEvents)
    .values({
      id: newId(),
      workspaceId,
      type: event.type,
      entityType: event.entityType,
      entityId: event.entityId,
      quantity: event.quantity,
      unit: UNIT[event.type],
      method: event.method,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: valueEvents.id });
  return rows.length > 0;
}

/** Compensation of an undo ([M7]): the entity stops counting and may be counted again later. */
export async function deleteValueEvent(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  type: ValueEventType,
  entityId: string,
): Promise<number> {
  const rows = await tx
    .delete(valueEvents)
    .where(
      and(
        eq(valueEvents.workspaceId, workspaceId),
        eq(valueEvents.type, type),
        eq(valueEvents.entityId, entityId),
      ),
    )
    .returning({ id: valueEvents.id });
  return rows.length;
}

/** Events of [from, to) ready for `buildValueReport`, labelled from the workspace's own tasks/commitments/time. */
export async function listValueEvents(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  range: { from: Date; to: Date },
): Promise<ValueEventInput[]> {
  const rows = await tx
    .select()
    .from(valueEvents)
    .where(
      and(
        eq(valueEvents.workspaceId, workspaceId),
        gte(valueEvents.createdAt, range.from),
        lt(valueEvents.createdAt, range.to),
      ),
    );
  const idsOf = (entityType: ValueEntityType) =>
    rows.filter((r) => r.entityType === entityType && r.entityId).map((r) => r.entityId as string);
  const labels = new Map<string, string>();
  const taskIds = idsOf("task");
  if (taskIds.length > 0)
    for (const t of await tx
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, taskIds))))
      labels.set(t.id, t.title);
  const commitmentIds = idsOf("commitment");
  if (commitmentIds.length > 0)
    for (const c of await tx
      .select({ id: commitments.id, action: commitments.action })
      .from(commitments)
      .where(and(eq(commitments.workspaceId, workspaceId), inArray(commitments.id, commitmentIds))))
      labels.set(c.id, c.action);
  const entryIds = idsOf("time_entry");
  if (entryIds.length > 0)
    for (const e of await tx
      .select({ id: timeEntries.id, description: timeEntries.description })
      .from(timeEntries)
      .where(and(eq(timeEntries.workspaceId, workspaceId), inArray(timeEntries.id, entryIds))))
      if (e.description) labels.set(e.id, e.description);

  const out: ValueEventInput[] = [];
  for (const r of rows) {
    // Rows with an unknown type/method (older data) are skipped rather than mis-reported.
    if (!r.entityId || !r.entityType || !isValueMethod(r.method) || !(r.type in UNIT)) continue;
    out.push({
      type: r.type as ValueEventType,
      entityType: r.entityType,
      entityId: r.entityId,
      quantity: r.quantity ?? 1,
      method: r.method,
      occurredAt: r.createdAt,
      label: labels.get(r.entityId) ?? null,
    });
  }
  return out;
}
