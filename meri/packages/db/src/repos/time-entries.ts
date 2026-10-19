/** D-042 time entries: inferred rows (idempotent insert), weekly listing, review and export. Never auto-approves. */
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { calendarEvents, clients, scheduleBlocks, tasks, timeEntries } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type TimeEntryStatus = "suggested" | "approved" | "rejected" | "exported";

export interface TimeEntryView {
  id: string;
  clientId: string | null;
  projectId: string | null;
  taskId: string | null;
  day: string;
  minutes: number;
  description: string | null;
  status: TimeEntryStatus;
  sourceType: string;
  sourceId: string | null;
  createdAt: Date;
  approvedAt: Date | null;
}

type Row = typeof timeEntries.$inferSelect;
const toView = (r: Row): TimeEntryView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export interface NewInferredEntry {
  sourceType: "calendar_event" | "schedule_block";
  sourceId: string;
  clientId: string;
  taskId: string | null;
  day: string;
  minutes: number;
  description: string;
}

/** Inserts the inferred entries that do not exist yet (one per source, any status). Returns how many were new. */
export async function insertInferredEntries(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entries: NewInferredEntry[],
  now: Date,
): Promise<number> {
  if (entries.length === 0) return 0;
  const rows = await tx
    .insert(timeEntries)
    .values(
      entries.map((e) => ({
        id: newId(),
        workspaceId,
        clientId: e.clientId,
        projectId: null,
        taskId: e.taskId,
        day: e.day,
        minutes: e.minutes,
        description: e.description,
        status: "suggested" as const,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: timeEntries.id });
  return rows.length;
}

export interface TimeEntryFilters {
  from: string;
  to: string;
  clientId?: string | undefined;
  /** Default: suggested + approved + exported (rejected hidden). */
  includeRejected?: boolean | undefined;
}

export async function listTimeEntries(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  f: TimeEntryFilters,
): Promise<TimeEntryView[]> {
  const rows = await tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        gte(timeEntries.day, f.from),
        lte(timeEntries.day, f.to),
        f.clientId ? eq(timeEntries.clientId, f.clientId) : undefined,
        f.includeRejected ? undefined : sql`${timeEntries.status} <> 'rejected'`,
      ),
    )
    .orderBy(asc(timeEntries.day), asc(timeEntries.createdAt), asc(timeEntries.id));
  return rows.map(toView);
}

export async function getTimeEntry(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<TimeEntryView | null> {
  const row = await tx.query.timeEntries.findFirst({
    where: and(eq(timeEntries.workspaceId, workspaceId), eq(timeEntries.id, id)),
  });
  return row ? toView(row) : null;
}

export async function getTimeEntriesByIds(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
): Promise<TimeEntryView[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.workspaceId, workspaceId), inArray(timeEntries.id, ids)));
  return rows.map(toView);
}

export async function updateTimeEntry(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: {
    minutes?: number;
    clientId?: string | null;
    description?: string | null;
    status?: TimeEntryStatus;
    approvedAt?: Date | null;
  },
): Promise<TimeEntryView | null> {
  const [row] = await tx
    .update(timeEntries)
    .set(patch)
    .where(and(eq(timeEntries.workspaceId, workspaceId), eq(timeEntries.id, id)))
    .returning();
  return row ? toView(row) : null;
}

/** Sets the status of several entries at once (one statement, one transaction). Returns the updated rows. */
export async function setTimeEntriesStatus(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
  status: TimeEntryStatus,
  now: Date,
): Promise<TimeEntryView[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .update(timeEntries)
    .set({ status, approvedAt: status === "approved" ? now : null })
    .where(and(eq(timeEntries.workspaceId, workspaceId), inArray(timeEntries.id, ids)))
    .returning();
  return rows.map(toView);
}

export interface CompletedBlockWithClient {
  id: string;
  taskId: string;
  taskTitle: string;
  clientId: string | null;
  startsAt: Date;
  endsAt: Date;
  completedAt: Date | null;
}

/** Completed Meri blocks in the window with their task's client (inference source, D-042). */
export async function listCompletedBlocks(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  range: { from: Date; to: Date },
): Promise<CompletedBlockWithClient[]> {
  return tx
    .select({
      id: scheduleBlocks.id,
      taskId: scheduleBlocks.taskId,
      taskTitle: tasks.title,
      clientId: tasks.clientId,
      startsAt: scheduleBlocks.startsAt,
      endsAt: scheduleBlocks.endsAt,
      completedAt: scheduleBlocks.completedAt,
    })
    .from(scheduleBlocks)
    .innerJoin(tasks, eq(tasks.id, scheduleBlocks.taskId))
    .where(
      and(
        eq(scheduleBlocks.workspaceId, workspaceId),
        isNotNull(scheduleBlocks.completedAt),
        gte(scheduleBlocks.startsAt, range.from),
        lt(scheduleBlocks.startsAt, range.to),
      ),
    )
    .orderBy(asc(scheduleBlocks.startsAt));
}

/** Names for the weekly summary and the CSV (deleted clients keep their name: history stays readable). */
export async function clientNamesById(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<Map<string, string>> {
  const rows = await tx.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Assigns an external event to a client (F-09: every item can belong to a client). */
export async function setCalendarEventClient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  eventId: string,
  clientId: string | null,
): Promise<{ id: string; clientId: string | null; origin: "meri" | "external" } | null> {
  const [row] = await tx
    .update(calendarEvents)
    .set({ clientId })
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId), eq(calendarEvents.origin, "external")))
    .returning({ id: calendarEvents.id, clientId: calendarEvents.clientId, origin: calendarEvents.origin });
  return row ?? null;
}
