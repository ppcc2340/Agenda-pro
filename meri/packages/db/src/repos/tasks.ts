import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { taskDependencies, tasks } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type TaskId, type WorkspaceId } from "../ids";

export const TASK_STATUSES = [
  "pending",
  "scheduled",
  "in_progress",
  "blocked",
  "waiting_on_third_party",
  "at_risk",
  "completed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const isoDate = z.string().datetime({ offset: true });

export const TaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(5000).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  kind: z.enum(["deep", "shallow"]).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  dueAt: isoDate.nullable().optional(),
  deadlineType: z.enum(["soft", "hard"]).optional(),
  estimateMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 10)
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
export const TaskPatchSchema = TaskInputSchema.partial();
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

export interface TaskView {
  id: TaskId;
  clientId: string | null;
  projectId: string | null;
  parentId: string | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  kind: "deep" | "shallow";
  priority: number;
  dueAt: Date | null;
  deadlineType: "soft" | "hard";
  estimateMinutes: number | null;
  tags: string[];
  origin: "user" | "ai_confirmed" | "system" | "integration";
  sourceCommitmentId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  blockedBy: string[];
}

export interface TaskFilters {
  status?: TaskStatus | undefined;
  clientId?: string | undefined;
  dueBefore?: Date | undefined;
  includeCompleted?: boolean | undefined;
}

type Row = typeof tasks.$inferSelect;

function toView(row: Row, blockedBy: string[]): TaskView {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return { ...rest, id: row.id as TaskId, blockedBy };
}

async function dependenciesFor(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  taskIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const rows = await tx
    .select({ taskId: taskDependencies.taskId, blockedBy: taskDependencies.blockedByTaskId })
    .from(taskDependencies)
    .where(and(eq(taskDependencies.workspaceId, workspaceId), inArray(taskDependencies.taskId, taskIds)))
    .orderBy(asc(taskDependencies.blockedByTaskId));
  for (const r of rows) map.set(r.taskId, [...(map.get(r.taskId) ?? []), r.blockedBy]);
  return map;
}

export async function listTasks(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  filters: TaskFilters,
  page: { limit: number; cursor?: string | undefined },
): Promise<{ items: TaskView[]; nextCursor: string | null }> {
  const where = and(
    eq(tasks.workspaceId, workspaceId),
    isNull(tasks.deletedAt),
    filters.status ? eq(tasks.status, filters.status) : undefined,
    filters.clientId ? eq(tasks.clientId, filters.clientId) : undefined,
    filters.dueBefore ? lte(tasks.dueAt, filters.dueBefore) : undefined,
    filters.includeCompleted || filters.status === "completed"
      ? undefined
      : sql`${tasks.status} <> 'completed'`,
    page.cursor ? lt(tasks.id, page.cursor) : undefined,
  );
  const rows = await tx
    .select()
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.id))
    .limit(page.limit + 1);
  const slice = rows.slice(0, page.limit);
  const deps = await dependenciesFor(
    tx,
    workspaceId,
    slice.map((r) => r.id),
  );
  const items = slice.map((r) => toView(r, deps.get(r.id) ?? []));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > page.limit && last ? last.id : null };
}

/** All non-deleted, non-completed tasks with dependencies: planner input and dependency validation. */
export async function listOpenTasks(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<TaskView[]> {
  const rows = await tx
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), sql`${tasks.status} <> 'completed'`),
    )
    .orderBy(asc(tasks.id));
  const deps = await dependenciesFor(
    tx,
    workspaceId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(r, deps.get(r.id) ?? []));
}

export async function getTask(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<TaskView | null> {
  const row = await tx.query.tasks.findFirst({
    where: and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id), isNull(tasks.deletedAt)),
  });
  if (!row) return null;
  const deps = await dependenciesFor(tx, workspaceId, [row.id]);
  return toView(row, deps.get(row.id) ?? []);
}

export async function createTask(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: TaskInput & { origin?: TaskView["origin"]; sourceCommitmentId?: string | null },
  now: Date,
): Promise<TaskView> {
  const id = newId() as TaskId;
  const [row] = await tx
    .insert(tasks)
    .values({
      id,
      workspaceId,
      title: input.title,
      notes: input.notes ?? null,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      status: input.status ?? "pending",
      kind: input.kind ?? "shallow",
      priority: input.priority ?? 3,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      deadlineType: input.deadlineType ?? "soft",
      estimateMinutes: input.estimateMinutes ?? null,
      tags: input.tags ?? [],
      origin: input.origin ?? "user",
      sourceCommitmentId: input.sourceCommitmentId ?? null,
      completedAt: input.status === "completed" ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("task insert returned no row");
  return toView(row, []);
}

export async function updateTask(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: TaskPatch,
  now: Date,
): Promise<TaskView | null> {
  const current = await getTask(tx, workspaceId, id);
  if (!current) return null;
  const nextStatus = patch.status ?? current.status;
  const [row] = await tx
    .update(tasks)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null } : {}),
      ...(patch.deadlineType !== undefined ? { deadlineType: patch.deadlineType } : {}),
      ...(patch.estimateMinutes !== undefined ? { estimateMinutes: patch.estimateMinutes } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      completedAt: nextStatus === "completed" ? (current.completedAt ?? now) : null,
      updatedAt: now,
    })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
    .returning();
  return row ? toView(row, current.blockedBy) : null;
}

export async function softDeleteTask(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  now: Date,
): Promise<TaskView | null> {
  const current = await getTask(tx, workspaceId, id);
  if (!current) return null;
  await tx
    .update(tasks)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)));
  await tx
    .delete(taskDependencies)
    .where(and(eq(taskDependencies.workspaceId, workspaceId), eq(taskDependencies.blockedByTaskId, id)));
  return current;
}

/** Replaces the blockedBy set of a task. Cycle validation happens in the caller with @meri/core (pure). */
export async function replaceDependencies(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  blockedBy: string[],
): Promise<string[]> {
  await tx
    .delete(taskDependencies)
    .where(and(eq(taskDependencies.workspaceId, workspaceId), eq(taskDependencies.taskId, id)));
  const unique = [...new Set(blockedBy)].sort();
  if (unique.length > 0) {
    await tx
      .insert(taskDependencies)
      .values(unique.map((blockedByTaskId) => ({ workspaceId, taskId: id, blockedByTaskId })));
  }
  return unique;
}

/** Bulk status update used by the planner to persist `at_risk`/`scheduled` (D-022). Never touches completed tasks. */
export async function setTaskStatuses(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  updates: { id: string; status: TaskStatus }[],
  now: Date,
): Promise<void> {
  for (const u of updates) {
    await tx
      .update(tasks)
      .set({ status: u.status, updatedAt: now })
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.id, u.id),
          sql`${tasks.status} <> 'completed'`,
          isNull(tasks.deletedAt),
        ),
      );
  }
}
