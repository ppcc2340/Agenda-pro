/** Pure helpers for the plan views (tested in plan.test.ts). Dates are rendered in the user's time zone. */
import type { Block, CalendarEvent, Plan, Reason } from "@/lib/types";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(date: Date, timeZone: string): LocalParts {
  const map: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: WEEKDAYS.indexOf(map.weekday ?? "Sun"),
  };
}

/** YYYY-MM-DD of `date` in the zone. */
export function dayKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
export function minuteOfDay(iso: string, timeZone: string): number {
  const p = localParts(new Date(iso), timeZone);
  return p.hour * 60 + p.minute;
}

/** UTC instant of local midnight for the day that contains `date` (DST-safe iteration). */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = localParts(date, timeZone);
  // Guess with the UTC midnight then correct by the zone offset at that instant.
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const g = localParts(new Date(guess), timeZone);
  const offsetMinutes = (g.hour * 60 + g.minute) * (g.day === p.day ? 1 : -1);
  const corrected =
    g.day === p.day ? guess - offsetMinutes * 60_000 : guess + (24 * 60 - g.hour * 60 - g.minute) * 60_000;
  return new Date(corrected);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Monday-based week containing `date`, as local day starts. */
export function weekDays(date: Date, timeZone: string, count = 5): Date[] {
  const start = startOfLocalDay(date, timeZone);
  const weekday = localParts(start, timeZone).weekday; // 0 = Sunday
  const monday = addDays(start, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: count }, (_, i) => startOfLocalDay(addDays(monday, i + 0.5), timeZone));
}

export interface DayItem {
  id: string;
  kind: "event" | "block";
  title: string;
  startsAt: string;
  endsAt: string;
  startMin: number;
  endMin: number;
  taskId: string | null;
  clientId: string | null;
  done: boolean;
  pinned: boolean;
}

/** Events and blocks of one local day, sorted by start. Meri's mirrored events are hidden (blocks represent them). */
export function dayItems(
  day: Date,
  timeZone: string,
  blocks: Block[],
  events: CalendarEvent[],
  tasks: Map<string, { title: string; clientId: string | null }>,
): DayItem[] {
  const key = dayKey(day, timeZone);
  const items: DayItem[] = [];
  for (const e of events) {
    if (e.origin !== "external" || e.allDay) continue;
    if (dayKey(new Date(e.startsAt), timeZone) !== key) continue;
    items.push({
      id: e.id,
      kind: "event",
      title: e.title ?? "",
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      startMin: minuteOfDay(e.startsAt, timeZone),
      endMin: minuteOfDay(e.endsAt, timeZone),
      taskId: null,
      clientId: e.clientId,
      done: false,
      pinned: false,
    });
  }
  for (const b of blocks) {
    if (dayKey(new Date(b.startsAt), timeZone) !== key) continue;
    const task = tasks.get(b.taskId);
    items.push({
      id: b.id,
      kind: "block",
      title: task?.title ?? "",
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      startMin: minuteOfDay(b.startsAt, timeZone),
      endMin: minuteOfDay(b.endsAt, timeZone),
      taskId: b.taskId,
      clientId: task?.clientId ?? null,
      done: b.completedAt !== null,
      pinned: b.pinned,
    });
  }
  return items.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
}

/** Block running now, else the next one today (demo "¿Qué hago ahora?"). */
export function currentBlock(items: DayItem[], nowMin: number): DayItem | null {
  const blocks = items.filter((i) => i.kind === "block" && !i.done);
  return (
    blocks.find((b) => b.startMin <= nowMin && nowMin < b.endMin) ??
    blocks.find((b) => b.startMin >= nowMin) ??
    null
  );
}

/** Stable client color index (1..4) from the client id; null → neutral. */
/** The client's own colour when it has one; otherwise a stable slot of the four-colour palette (docs/11). */
export function clientColorVar(clientId: string | null, clients: { id: string; color?: string | null }[]): string {
  if (!clientId) return "var(--ink3)";
  const own = clients.find((c) => c.id === clientId)?.color;
  if (own) return own;
  const idx = clients.findIndex((c) => c.id === clientId);
  const n = (idx >= 0 ? idx : clientId.charCodeAt(clientId.length - 1)) % 4;
  return `var(--c-${String(n + 1)})`;
}

export type ReasonCode =
  | "DEADLINE_SLACK_LOW"
  | "DEADLINE_HARD"
  | "HIGH_PRIORITY"
  | "UNBLOCKS_OTHERS"
  | "DEEP_WORK_WINDOW"
  | "FILLS_GAP"
  | "PINNED_BY_USER"
  | "KEPT_STABLE"
  | "DEPENDENCY_ORDER";

export const REASON_CODES: ReasonCode[] = [
  "DEADLINE_SLACK_LOW",
  "DEADLINE_HARD",
  "HIGH_PRIORITY",
  "UNBLOCKS_OTHERS",
  "DEEP_WORK_WINDOW",
  "FILLS_GAP",
  "PINNED_BY_USER",
  "KEPT_STABLE",
  "DEPENDENCY_ORDER",
];

export const isReasonCode = (code: string): code is ReasonCode => (REASON_CODES as string[]).includes(code);

/** Parameters passed to the i18n message of a reason; numbers rounded for display. */
export function reasonParams(reason: Reason): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(reason.params)) {
    if (typeof v === "number") out[k] = Math.round(v * 10) / 10;
    else if (typeof v === "string" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

export interface RiskRow {
  taskId: string;
  title: string;
  clientId: string | null;
  kind: "risk" | "conflict";
  code: string;
  slackHours: number | null;
  alternatives: string[];
  /** A reschedule proposal exists that may fix this. */
  fix: "reorganize" | "replan";
}

/** "¿Qué podría salir mal?": one row per task, risks first, conflicts attached (F-13). */
export function riskRows(plan: Pick<Plan, "risks" | "conflicts" | "tasks" | "pendingProposal">): RiskRow[] {
  const tasks = new Map(plan.tasks.map((t) => [t.id, t]));
  const rows = new Map<string, RiskRow>();
  const fix = plan.pendingProposal ? "reorganize" : "replan";
  const push = (taskId: string, partial: Omit<RiskRow, "taskId" | "title" | "clientId" | "fix">) => {
    const task = tasks.get(taskId);
    if (!task || rows.has(taskId)) return;
    rows.set(taskId, { taskId, title: task.title, clientId: task.clientId, fix, ...partial });
  };
  for (const r of plan.risks)
    push(r.taskId, { kind: "risk", code: r.cause, slackHours: r.slackHours, alternatives: [] });
  for (const c of plan.conflicts) {
    for (const id of c.taskIds)
      push(id, { kind: "conflict", code: c.code, slackHours: null, alternatives: c.alternatives });
  }
  return [...rows.values()];
}
