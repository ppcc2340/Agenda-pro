/**
 * D-042 time inference (F-10): pure rules, no AI. Sources are ended external calendar events with a client and
 * completed Meri blocks whose task has a client. One entry per source (the caller inserts with ON CONFLICT DO
 * NOTHING, so re-inference is idempotent and never resurrects a rejected entry). Nothing here approves anything.
 */
import { addLocalDays, fromLocalParts, localDateKey, toLocalParts } from "./local";

export type RoundingMinutes = 6 | 15;
export const ROUNDING_OPTIONS: readonly RoundingMinutes[] = [6, 15];
/** Event ↔ block overlap (share of the event) above which the block wins and the event yields no entry. */
export const BLOCK_WINS_OVERLAP = 0.5;

export interface InferEvent {
  id: string;
  clientId: string | null;
  title: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  busy: boolean;
  origin: "external" | "meri";
}

export interface InferBlock {
  id: string;
  taskId: string;
  taskTitle: string;
  clientId: string | null;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
}

export interface InferInput {
  now: string;
  timezone: string;
  roundingMinutes: RoundingMinutes;
  events: InferEvent[];
  blocks: InferBlock[];
}

export interface InferredEntry {
  sourceType: "calendar_event" | "schedule_block";
  sourceId: string;
  clientId: string;
  taskId: string | null;
  /** Local day (YYYY-MM-DD) of the source start in the user's time zone. */
  day: string;
  minutes: number;
  description: string;
}

export interface InferResult {
  entries: InferredEntry[];
  /** Ended external events without a client: "tiempo no registrado" with an "assign client" action. */
  unassignedEventIds: string[];
}

const MINUTE = 60_000;
const ms = (iso: string) => Date.parse(iso);

/** Always up to the next unit, at least one unit (6 → 1 min = 6, 61 → 66; 15 → 1 min = 15). */
export function roundMinutes(minutes: number, step: RoundingMinutes): number {
  if (minutes <= 0) return step;
  return Math.ceil(minutes / step) * step;
}

const durationMinutes = (startsAt: string, endsAt: string) => Math.max(0, (ms(endsAt) - ms(startsAt)) / MINUTE);
const overlapMinutes = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) =>
  Math.max(0, Math.min(ms(a.endsAt), ms(b.endsAt)) - Math.max(ms(a.startsAt), ms(b.startsAt))) / MINUTE;

export function inferTimeEntries(input: InferInput): InferResult {
  const now = ms(input.now);
  const entries: InferredEntry[] = [];
  const unassignedEventIds: string[] = [];
  const completed = input.blocks.filter((b) => b.completedAt !== null && b.clientId !== null);
  for (const b of completed) {
    entries.push({
      sourceType: "schedule_block",
      sourceId: b.id,
      clientId: b.clientId as string,
      taskId: b.taskId,
      day: localDateKey(ms(b.startsAt), input.timezone),
      minutes: roundMinutes(durationMinutes(b.startsAt, b.endsAt), input.roundingMinutes),
      description: b.taskTitle,
    });
  }
  const ended = input.events.filter(
    (e) => e.origin === "external" && e.busy && !e.allDay && ms(e.endsAt) <= now && ms(e.endsAt) > ms(e.startsAt),
  );
  for (const e of ended) {
    if (e.clientId === null) {
      unassignedEventIds.push(e.id);
      continue;
    }
    const duration = durationMinutes(e.startsAt, e.endsAt);
    const covered = completed
      .filter((b) => b.clientId === e.clientId)
      .reduce((sum, b) => sum + overlapMinutes(e, b), 0);
    if (duration > 0 && covered / duration >= BLOCK_WINS_OVERLAP) continue; // the block wins
    entries.push({
      sourceType: "calendar_event",
      sourceId: e.id,
      clientId: e.clientId,
      taskId: null,
      day: localDateKey(ms(e.startsAt), input.timezone),
      minutes: roundMinutes(duration, input.roundingMinutes),
      description: e.title ?? "",
    });
  }
  entries.sort((a, b) => a.day.localeCompare(b.day) || a.sourceId.localeCompare(b.sourceId));
  return { entries, unassignedEventIds };
}

// ---------- ISO weeks (Monday–Sunday in the user's time zone) ----------

export interface WeekRange {
  key: string;
  /** Local days YYYY-MM-DD, Monday first. */
  days: string[];
  /** UTC instants of local Monday 00:00 and the following Monday 00:00. */
  from: Date;
  to: Date;
}

const WEEK_RE = /^(\d{4})-W(\d{2})$/;

function isoWeekOfLocalDate(p: { year: number; month: number; day: number }): { year: number; week: number } {
  // ISO 8601: week 1 contains the first Thursday; computed on UTC-noon to dodge DST.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1, 12);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** `YYYY-Www` of the local week containing the instant. */
export function isoWeekKey(epochMs: number, timeZone: string): string {
  const { year, week } = isoWeekOfLocalDate(toLocalParts(epochMs, timeZone));
  return `${String(year)}-W${String(week).padStart(2, "0")}`;
}

/** The seven local days and UTC bounds of a `YYYY-Www` key; null for a malformed key. */
export function isoWeekRange(key: string, timeZone: string): WeekRange | null {
  const m = WEEK_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // Monday of ISO week 1 = Monday on or before 4 January.
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const jan4Dow = jan4.getUTCDay() || 7;
  const monday = { year, month: 1, day: 4 - (jan4Dow - 1) + (week - 1) * 7 };
  const start = addLocalDays(monday, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addLocalDays(start, i);
    return `${String(d.year)}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  });
  const next = addLocalDays(start, 7);
  return {
    key,
    days,
    from: new Date(fromLocalParts({ ...start, hour: 0, minute: 0 }, timeZone)),
    to: new Date(fromLocalParts({ ...next, hour: 0, minute: 0 }, timeZone)),
  };
}
