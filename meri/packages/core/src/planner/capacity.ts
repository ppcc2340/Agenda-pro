/**
 * Step 2 of docs/04: per local work day, the free windows (work hours minus busy
 * fixed events and their transition buffer) and the assignable capacity after
 * reserving `contingencyPct` for the unexpected. The reserve is never assigned.
 */
import {
  addDays,
  compareLocalDate,
  localDateKey,
  localParts,
  localToUtcMinutes,
  weekdayOf,
  type LocalDate,
} from "./calendar-math";
import { normalize, type Normalized, type NormalizedPreferences } from "./normalize";
import type { PlanInput } from "./types";

export interface Slot {
  readonly start: number;
  readonly end: number;
}

export interface DayState {
  /** "YYYY-MM-DD" in the user's zone. */
  readonly key: string;
  readonly index: number;
  readonly workStart: number;
  readonly workEnd: number;
  /** Deep-work windows of this day, clipped to the work window (UTC minutes). */
  readonly deepWindows: readonly Slot[];
  /** Work window minus fixed events (+buffer), `now` and the horizon; never mutated. */
  readonly baseFree: readonly Slot[];
  /** Minutes of task work that may be assigned on this day. */
  readonly capacity: number;
  /** `baseFree` minus every block (+buffer) placed so far. */
  free: Slot[];
  /** Minutes of task work assigned on this day so far. */
  assigned: number;
}

export function slotMinutes(slots: readonly Slot[]): number {
  return slots.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** Removes [start, end) from a sorted list of disjoint slots. */
export function subtractInterval(slots: readonly Slot[], start: number, end: number): Slot[] {
  const result: Slot[] = [];
  for (const slot of slots) {
    if (end <= slot.start || start >= slot.end) {
      result.push(slot);
      continue;
    }
    if (slot.start < start) result.push({ start: slot.start, end: start });
    if (end < slot.end) result.push({ start: end, end: slot.end });
  }
  return result;
}

/** Parts of `slots` that fall inside any of `windows` (both sorted and disjoint). */
export function intersectSlots(slots: readonly Slot[], windows: readonly Slot[]): Slot[] {
  const result: Slot[] = [];
  for (const slot of slots) {
    for (const window of windows) {
      const start = Math.max(slot.start, window.start);
      const end = Math.min(slot.end, window.end);
      if (start < end) result.push({ start, end });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

/** Minutes of `slots` that fall inside [from, to). */
export function overlapMinutes(slots: readonly Slot[], from: number, to: number): number {
  let total = 0;
  for (const slot of slots) {
    const start = Math.max(slot.start, from);
    const end = Math.min(slot.end, to);
    if (start < end) total += end - start;
  }
  return total;
}

function capacityFactor(prefs: NormalizedPreferences): number {
  return 1 - prefs.contingencyPct / 100;
}

function buildDay(n: Normalized, date: LocalDate, index: number): DayState | null {
  const prefs = n.preferences;
  const workStart = Math.max(localToUtcMinutes(date, prefs.workStart, prefs.timezone), n.horizonStart, n.now);
  const workEnd = Math.min(localToUtcMinutes(date, prefs.workEnd, prefs.timezone), n.horizonEnd);
  if (workStart >= workEnd) return null;
  let baseFree: Slot[] = [{ start: workStart, end: workEnd }];
  for (const event of n.fixedEvents) {
    // Transition buffer applies after a fixed event (docs/04 §2 "buffers").
    baseFree = subtractInterval(baseFree, event.start, event.end + prefs.bufferMinutes);
  }
  const deepWindows = prefs.deepWorkWindows
    .map((w) => ({
      start: Math.max(localToUtcMinutes(date, w.start, prefs.timezone), workStart),
      end: Math.min(localToUtcMinutes(date, w.end, prefs.timezone), workEnd),
    }))
    .filter((w) => w.start < w.end)
    .sort((a, b) => a.start - b.start);
  return {
    key: localDateKey(date),
    index,
    workStart,
    workEnd,
    deepWindows,
    baseFree,
    capacity: Math.floor(slotMinutes(baseFree) * capacityFactor(prefs)),
    free: [...baseFree],
    assigned: 0,
  };
}

/** One state per local work day of the horizon, in chronological order. */
export function buildDays(n: Normalized): DayState[] {
  const prefs = n.preferences;
  const firstDate = localParts(n.horizonStart, prefs.timezone);
  const lastDate = localParts(n.horizonEnd, prefs.timezone);
  const days: DayState[] = [];
  for (let date: LocalDate = firstDate; compareLocalDate(date, lastDate) <= 0; date = addDays(date, 1)) {
    if (!prefs.workDays.has(weekdayOf(date))) continue;
    const day = buildDay(n, date, days.length);
    if (day !== null) days.push(day);
  }
  return days;
}

/**
 * Gross assignable minutes (capacity, ignoring what is already assigned) that
 * fall inside [from, to). Used for slack: how much work time exists between a
 * task's planned finish and its deadline.
 */
export function grossCapacityBetween(
  days: readonly DayState[],
  prefs: NormalizedPreferences,
  from: number,
  to: number,
): number {
  let total = 0;
  for (const day of days) total += overlapMinutes(day.baseFree, from, to);
  return Math.floor(total * capacityFactor(prefs));
}

export interface DailyCapacity {
  date: string;
  capacityMinutes: number;
}

/** Public helper: assignable minutes per local day, with the contingency reserve removed. */
export function computeDailyCapacity(input: PlanInput): DailyCapacity[] {
  return buildDays(normalize(input)).map((d) => ({ date: d.key, capacityMinutes: d.capacity }));
}

export interface DailyMargin {
  /** "YYYY-MM-DD" in the user's zone. */
  day: string;
  /** Minutes reserved for the unexpected (never assigned): free minutes minus assignable capacity. */
  minutes: number;
  /** The reserve is drawn at the end of the work day: [workEnd − minutes, workEnd) in UTC ISO. */
  startsAt: string;
  endsAt: string;
}

const isoOfMinutes = (utcMinutes: number): string => new Date(utcMinutes * 60_000).toISOString();

/**
 * Public helper (D-051): the contingency reserve per local day, so the day line can draw the hatched margin
 * without running the planner. Days without free time (or without reserve) are omitted.
 */
export function computeDailyMargin(input: PlanInput): DailyMargin[] {
  return buildDays(normalize(input))
    .map((d) => ({ day: d.key, minutes: slotMinutes(d.baseFree) - d.capacity, workEnd: d.workEnd }))
    .filter((d) => d.minutes > 0)
    .map((d) => ({
      day: d.day,
      minutes: d.minutes,
      startsAt: isoOfMinutes(d.workEnd - d.minutes),
      endsAt: isoOfMinutes(d.workEnd),
    }));
}
