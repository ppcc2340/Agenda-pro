import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { scheduleBlocks, tasks } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface ScheduleBlockView {
  id: string;
  taskId: string;
  startsAt: Date;
  endsAt: Date;
  pinned: boolean;
  reason: { code: string; params: Record<string, unknown> }[];
  calendarEventId: string | null;
  planVersion: number;
  completedAt: Date | null;
  createdAt: Date;
}

type Row = typeof scheduleBlocks.$inferSelect;
const toView = (r: Row): ScheduleBlockView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export async function listBlocks(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  range?: { from: Date; to: Date },
): Promise<ScheduleBlockView[]> {
  const rows = await tx
    .select()
    .from(scheduleBlocks)
    .where(
      and(
        eq(scheduleBlocks.workspaceId, workspaceId),
        range ? lte(scheduleBlocks.startsAt, range.to) : undefined,
        range ? gte(scheduleBlocks.endsAt, range.from) : undefined,
      ),
    )
    .orderBy(asc(scheduleBlocks.startsAt), asc(scheduleBlocks.id));
  return rows.map(toView);
}

export async function getBlock(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<ScheduleBlockView | null> {
  const row = await tx.query.scheduleBlocks.findFirst({
    where: and(eq(scheduleBlocks.workspaceId, workspaceId), eq(scheduleBlocks.id, id)),
  });
  return row ? toView(row) : null;
}

export interface NewBlock {
  taskId: string;
  startsAt: Date;
  endsAt: Date;
  pinned?: boolean;
  reason: { code: string; params: Record<string, unknown> }[];
  calendarEventId?: string | null;
}

export async function insertBlocks(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  blocks: NewBlock[],
  planVersion: number,
  now: Date,
): Promise<ScheduleBlockView[]> {
  if (blocks.length === 0) return [];
  const rows = await tx
    .insert(scheduleBlocks)
    .values(
      blocks.map((b) => ({
        id: newId(),
        workspaceId,
        taskId: b.taskId,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        pinned: b.pinned ?? false,
        reason: b.reason,
        calendarEventId: b.calendarEventId ?? null,
        planVersion,
        createdAt: now,
      })),
    )
    .returning();
  return rows.map(toView);
}

export async function deleteBlocks(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
): Promise<ScheduleBlockView[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .delete(scheduleBlocks)
    .where(and(eq(scheduleBlocks.workspaceId, workspaceId), inArray(scheduleBlocks.id, ids)))
    .returning();
  return rows.map(toView);
}

export async function updateBlock(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: {
    startsAt?: Date;
    endsAt?: Date;
    pinned?: boolean;
    calendarEventId?: string | null;
    completedAt?: Date | null;
    planVersion?: number;
  },
): Promise<ScheduleBlockView | null> {
  const [row] = await tx
    .update(scheduleBlocks)
    .set(patch)
    .where(and(eq(scheduleBlocks.workspaceId, workspaceId), eq(scheduleBlocks.id, id)))
    .returning();
  return row ? toView(row) : null;
}

/** Current plan version = max(plan_version) over the workspace blocks (0 when there is no plan yet). */
export async function currentPlanVersion(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<number> {
  const rows = await tx
    .select({ v: sql<number>`coalesce(max(${scheduleBlocks.planVersion}), 0)` })
    .from(scheduleBlocks)
    .where(eq(scheduleBlocks.workspaceId, workspaceId));
  return rows[0]?.v ?? 0;
}

/** Blocks whose task is completed or deleted: safe to remove (ADR 0003). */
export async function orphanBlockIds(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<string[]> {
  const rows = await tx
    .select({ id: scheduleBlocks.id })
    .from(scheduleBlocks)
    .innerJoin(tasks, eq(tasks.id, scheduleBlocks.taskId))
    .where(
      and(
        eq(scheduleBlocks.workspaceId, workspaceId),
        sql`(${tasks.status} = 'completed' or ${tasks.deletedAt} is not null)`,
        isNull(scheduleBlocks.completedAt),
      ),
    );
  return rows.map((r) => r.id);
}
