/**
 * Daily close and weekly review (F-12, D-064): template summaries over the user's own plan, no AI. Pure: the
 * caller loads tasks, blocks and time for the ranges and passes them in.
 */
export interface ReviewTask {
  id: string;
  title: string;
  clientId: string | null;
  status: string;
  completedAt: Date | null;
  estimateMinutes: number | null;
  /** When the planner flagged the task at risk (null when it is not at risk). */
  riskSince: Date | null;
}

export interface ReviewBlock {
  taskId: string;
  startsAt: Date;
  endsAt: Date;
  completedAt: Date | null;
}

interface Range {
  from: Date;
  to: Date;
}

const within = (d: Date | null, r: Range) => d !== null && d.getTime() >= r.from.getTime() && d.getTime() < r.to.getTime();
const minutes = (b: { startsAt: Date; endsAt: Date }) => Math.max(0, Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000));
const BLOCKED = new Set(["blocked", "waiting_on_third_party"]);

export interface ReviewItem {
  taskId: string;
  title: string;
  clientId: string | null;
}

export interface DailyClose {
  done: ReviewItem[];
  /** Planned today and not done yet, still ahead of `now`. */
  pending: ReviewItem[];
  /** Planned today, already past and not done: Meri will reschedule them. */
  toReschedule: ReviewItem[];
  blocked: ReviewItem[];
  newRisks: ReviewItem[];
  /** First blocks of tomorrow, one per task, in order (at most three). */
  tomorrow: (ReviewItem & { startsAt: string })[];
}

export function buildDailyClose(input: {
  today: Range;
  tomorrow: Range;
  now: Date;
  tasks: readonly ReviewTask[];
  blocks: readonly ReviewBlock[];
}): DailyClose {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const item = (t: ReviewTask): ReviewItem => ({ taskId: t.id, title: t.title, clientId: t.clientId });
  const open = (t: ReviewTask | undefined): t is ReviewTask => t !== undefined && t.status !== "completed";
  const todayBlocks = input.blocks.filter((b) => within(b.startsAt, input.today) && b.completedAt === null);
  const unique = (ids: string[]) => [...new Set(ids)];
  const pendingIds = unique(todayBlocks.filter((b) => b.endsAt.getTime() > input.now.getTime()).map((b) => b.taskId));
  const pastIds = unique(todayBlocks.filter((b) => b.endsAt.getTime() <= input.now.getTime()).map((b) => b.taskId)).filter(
    (id) => !pendingIds.includes(id),
  );
  const tomorrowBlocks = [...input.blocks]
    .filter((b) => within(b.startsAt, input.tomorrow))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const seen = new Set<string>();
  const tomorrow: DailyClose["tomorrow"] = [];
  for (const b of tomorrowBlocks) {
    const t = byId.get(b.taskId);
    if (!open(t) || seen.has(t.id)) continue;
    seen.add(t.id);
    tomorrow.push({ ...item(t), startsAt: b.startsAt.toISOString() });
    if (tomorrow.length === 3) break;
  }
  return {
    done: input.tasks.filter((t) => t.status === "completed" && within(t.completedAt, input.today)).map(item),
    pending: pendingIds.map((id) => byId.get(id)).filter(open).map(item),
    toReschedule: pastIds.map((id) => byId.get(id)).filter(open).map(item),
    blocked: input.tasks.filter((t) => BLOCKED.has(t.status)).map(item),
    newRisks: input.tasks.filter((t) => open(t) && within(t.riskSince, input.today)).map(item),
    tomorrow,
  };
}

export interface WeeklyDay {
  day: string;
  capacityMinutes: number;
  plannedMinutes: number;
  completedMinutes: number;
  /** planned / capacity (null without capacity: a non-working day). */
  load: number | null;
}

export interface EstimateRow extends ReviewItem {
  estimateMinutes: number;
  actualMinutes: number;
  /** (actual − estimate) / estimate, as a percentage rounded to an integer. */
  deltaPct: number;
}

export interface WeeklyReview {
  days: WeeklyDay[];
  totals: { capacityMinutes: number; plannedMinutes: number; completedMinutes: number };
  /** Completed tasks with an estimate and some measured time (blocks done or approved time). */
  estimates: EstimateRow[];
  /** Median of |deltaPct| over `estimates` (null without rows). */
  medianEstimateErrorPct: number | null;
  trend: { previousPlannedMinutes: number; previousCompletedMinutes: number; plannedDeltaPct: number | null } | null;
}

export function buildWeeklyReview(input: {
  days: readonly { day: string; from: Date; to: Date; capacityMinutes: number }[];
  tasks: readonly ReviewTask[];
  blocks: readonly ReviewBlock[];
  /**
   * Approved minutes per task in the week (time entries). Time entries are inferred from completed blocks
   * (D-042), so the approved time replaces the block minutes when present: never both, never double-counted.
   */
  approvedMinutesByTask: ReadonlyMap<string, number>;
  previous: { plannedMinutes: number; completedMinutes: number } | null;
}): WeeklyReview {
  const days = input.days.map((d): WeeklyDay => {
    const blocks = input.blocks.filter((b) => within(b.startsAt, d));
    const planned = blocks.reduce((s, b) => s + minutes(b), 0);
    const completed = blocks.filter((b) => b.completedAt !== null).reduce((s, b) => s + minutes(b), 0);
    return {
      day: d.day,
      capacityMinutes: d.capacityMinutes,
      plannedMinutes: planned,
      completedMinutes: completed,
      load: d.capacityMinutes > 0 ? Math.round((planned / d.capacityMinutes) * 100) / 100 : null,
    };
  });
  const totals = days.reduce(
    (t, d) => ({
      capacityMinutes: t.capacityMinutes + d.capacityMinutes,
      plannedMinutes: t.plannedMinutes + d.plannedMinutes,
      completedMinutes: t.completedMinutes + d.completedMinutes,
    }),
    { capacityMinutes: 0, plannedMinutes: 0, completedMinutes: 0 },
  );
  const week: Range = { from: input.days[0]?.from ?? new Date(0), to: input.days[input.days.length - 1]?.to ?? new Date(0) };
  const estimates: EstimateRow[] = [];
  for (const t of input.tasks) {
    if (t.status !== "completed" || !within(t.completedAt, week) || !t.estimateMinutes) continue;
    const blockMinutes = input.blocks
      .filter((b) => b.taskId === t.id && b.completedAt !== null)
      .reduce((s, b) => s + minutes(b), 0);
    const approved = input.approvedMinutesByTask.get(t.id);
    const actual = approved !== undefined && approved > 0 ? approved : blockMinutes;
    if (actual === 0) continue;
    estimates.push({
      taskId: t.id,
      title: t.title,
      clientId: t.clientId,
      estimateMinutes: t.estimateMinutes,
      actualMinutes: actual,
      deltaPct: Math.round(((actual - t.estimateMinutes) / t.estimateMinutes) * 100),
    });
  }
  const errors = estimates.map((e) => Math.abs(e.deltaPct)).sort((a, b) => a - b);
  const mid = Math.floor(errors.length / 2);
  const median =
    errors.length === 0 ? null : errors.length % 2 === 1 ? (errors[mid] ?? 0) : Math.round(((errors[mid - 1] ?? 0) + (errors[mid] ?? 0)) / 2);
  const trend = input.previous
    ? {
        previousPlannedMinutes: input.previous.plannedMinutes,
        previousCompletedMinutes: input.previous.completedMinutes,
        plannedDeltaPct:
          input.previous.plannedMinutes > 0
            ? Math.round(((totals.plannedMinutes - input.previous.plannedMinutes) / input.previous.plannedMinutes) * 100)
            : null,
      }
    : null;
  return { days, totals, estimates, medianEstimateErrorPct: median, trend };
}
