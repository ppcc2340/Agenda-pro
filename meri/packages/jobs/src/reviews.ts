/**
 * Daily close and weekly review loaders (D-064): read the workspace's own plan, tasks and approved time for the
 * user's local ranges and hand them to the pure builders in `@meri/core`. No AI. Also the `daily.close` handler.
 */
import {
  addLocalDays,
  buildDailyClose,
  buildWeeklyReview,
  computeDailyCapacity,
  fromLocalParts,
  isoWeekKey,
  isoWeekRange,
  localDateKey,
  toLocalParts,
  type DailyClose,
  type ReviewBlock,
  type ReviewTask,
  type WeeklyReview,
} from "@meri/core";
import {
  getPreferences,
  insertNotification,
  listBlocks,
  listCalendarEvents,
  listTasksForReview,
  listTimeEntries,
  notificationExistsForRef,
  withWorkspace,
  type PreferencesView,
  type TaskView,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { toPlannerPreferences } from "./handlers/replan";
import type { HandlerDeps } from "./handlers/context";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC bounds of a local day `YYYY-MM-DD`; null for a malformed or impossible date. */
export function localDayRange(day: string, timeZone: string): { from: Date; to: Date } | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const p = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const next = addLocalDays(p, 1);
  const from = fromLocalParts({ ...p, hour: 0, minute: 0 }, timeZone);
  if (Number.isNaN(from) || toLocalParts(from, timeZone).day !== p.day) return null;
  return { from: new Date(from), to: new Date(fromLocalParts({ ...next, hour: 0, minute: 0 }, timeZone)) };
}

const toReviewTask = (t: TaskView): ReviewTask => ({
  id: t.id,
  title: t.title,
  clientId: t.clientId,
  status: t.status,
  completedAt: t.completedAt,
  estimateMinutes: t.estimateMinutes,
  riskSince: t.risk ? new Date(t.risk.since) : null,
});

async function loadReviewData(tx: WorkspaceTx, workspaceId: WorkspaceId, range: { from: Date; to: Date }) {
  const [tasks, blocks] = await Promise.all([
    listTasksForReview(tx, workspaceId, range.from),
    listBlocks(tx, workspaceId, range),
  ]);
  return {
    tasks: tasks.map(toReviewTask),
    blocks: blocks.map((b): ReviewBlock => ({
      taskId: b.taskId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      completedAt: b.completedAt,
    })),
  };
}

export async function loadDailyClose(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  prefs: PreferencesView,
  day: string,
  now: Date,
): Promise<(DailyClose & { date: string }) | null> {
  const today = localDayRange(day, prefs.timezone);
  if (!today) return null;
  const tomorrowKey = localDateKey(today.to.getTime() + 12 * 3_600_000, prefs.timezone);
  const tomorrow = localDayRange(tomorrowKey, prefs.timezone);
  if (!tomorrow) return null;
  const data = await loadReviewData(tx, workspaceId, { from: today.from, to: tomorrow.to });
  return { date: day, ...buildDailyClose({ today, tomorrow, now, ...data }) };
}

export async function loadWeeklyReview(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  prefs: PreferencesView,
  weekKey: string,
): Promise<(WeeklyReview & { week: string; days: WeeklyReview["days"] }) | null> {
  const week = isoWeekRange(weekKey, prefs.timezone);
  if (!week) return null;
  // Four days before local Monday is the previous week's Thursday: its ISO week is the previous week.
  const previous = isoWeekRange(
    isoWeekKey(week.from.getTime() - 4 * 86_400_000, prefs.timezone),
    prefs.timezone,
  );
  const [data, events, entries, prevBlocks] = await Promise.all([
    loadReviewData(tx, workspaceId, week),
    listCalendarEvents(tx, workspaceId, { from: week.from, to: week.to }),
    listTimeEntries(tx, workspaceId, { from: week.days[0] ?? "", to: week.days[6] ?? "" }),
    previous ? listBlocks(tx, workspaceId, previous) : Promise.resolve([]),
  ]);
  // Capacity of the whole week (from its first minute) after third-party meetings; Meri's blocks are the plan.
  const capacity = computeDailyCapacity({
    now: week.from.toISOString(),
    horizonStart: week.from.toISOString(),
    horizonEnd: week.to.toISOString(),
    tasks: [],
    fixedEvents: events
      .filter((e) => e.origin === "external")
      .map((e) => ({
        id: e.id,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        busy: e.busy && !e.allDay,
      })),
    existingBlocks: [],
    preferences: toPlannerPreferences(prefs),
  });
  const days = week.days.map((day) => {
    const r = localDayRange(day, prefs.timezone) ?? { from: week.from, to: week.from };
    return { day, ...r, capacityMinutes: capacity.find((c) => c.date === day)?.capacityMinutes ?? 0 };
  });
  const approvedMinutesByTask = new Map<string, number>();
  for (const e of entries)
    if (e.taskId && (e.status === "approved" || e.status === "exported"))
      approvedMinutesByTask.set(e.taskId, (approvedMinutesByTask.get(e.taskId) ?? 0) + e.minutes);
  const minutesOf = (b: { startsAt: Date; endsAt: Date }) =>
    Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000);
  const inPrevious = previous
    ? prevBlocks.filter((b) => b.startsAt >= previous.from && b.startsAt < previous.to)
    : [];
  const review = buildWeeklyReview({
    days,
    ...data,
    approvedMinutesByTask,
    previous: previous
      ? {
          plannedMinutes: inPrevious.reduce((s, b) => s + minutesOf(b), 0),
          completedMinutes: inPrevious
            .filter((b) => b.completedAt !== null)
            .reduce((s, b) => s + minutesOf(b), 0),
        }
      : null,
  });
  return { week: week.key, ...review };
}

export interface DailyCloseResult {
  status: "sent" | "duplicate" | "skipped";
  done: number;
  toReschedule: number;
}

/** daily.close (D-064): one end-of-day notification per local day, with ids only in `refs`. */
export async function runDailyClose(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  input: { date: string },
): Promise<DailyCloseResult> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs) return { status: "skipped", done: 0, toReschedule: 0 };
    const ref = { type: "day", id: input.date };
    if (await notificationExistsForRef(tx, workspaceId, "daily.close", ref))
      return { status: "duplicate", done: 0, toReschedule: 0 };
    const close = await loadDailyClose(tx, workspaceId, prefs, input.date, now);
    if (!close) return { status: "skipped", done: 0, toReschedule: 0 };
    const params = {
      done: close.done.length,
      pending: close.pending.length,
      toReschedule: close.toReschedule.length,
      newRisks: close.newRisks.length,
      tomorrow: close.tomorrow.length,
    };
    await insertNotification(
      tx,
      workspaceId,
      {
        kind: "digest",
        template: "daily.close",
        params,
        title: "Cierre del día",
        body: `${String(params.done)} hechas, ${String(params.toReschedule)} por reprogramar, ${String(params.tomorrow)} prioridades para mañana.`,
        refs: [ref, ...close.tomorrow.map((t) => ({ type: "task", id: t.taskId }))],
        day: input.date,
      },
      now,
    );
    return { status: "sent", done: params.done, toReschedule: params.toReschedule };
  });
}

/** Workspaces whose local clock is past work end today and that have no close for today (dispatcher input). */
export function dueForClose(
  rows: { workspaceId: string; timezone: string; workEnd: string; lastCloseDay: string | null }[],
  now: Date,
): { workspaceId: string; date: string }[] {
  const due: { workspaceId: string; date: string }[] = [];
  for (const r of rows) {
    let date: string;
    let local: ReturnType<typeof toLocalParts>;
    try {
      date = localDateKey(now.getTime(), r.timezone);
      local = toLocalParts(now.getTime(), r.timezone);
    } catch {
      continue;
    }
    const [h = "0", m = "0"] = r.workEnd.split(":");
    if (local.hour * 60 + local.minute < Number(h) * 60 + Number(m)) continue;
    if (r.lastCloseDay === date) continue;
    due.push({ workspaceId: r.workspaceId, date });
  }
  return due;
}
