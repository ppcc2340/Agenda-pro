/**
 * Calendar arithmetic on epoch minutes with IANA time zones, using only Intl
 * (no date libraries). Every instant inside the planner is an integer number of
 * minutes since the Unix epoch (UTC). Wall-clock conversions are needed only to
 * expand work hours and deep-work windows per *local* day, which is where DST
 * matters: a work day on a DST transition has 23 or 25 wall-clock hours.
 */

export const MINUTE_MS = 60_000;
export const MINUTES_PER_DAY = 24 * 60;

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday, matching PlannerPreferences.workDays */
  weekday: number;
}

export interface WallTime {
  hour: number;
  minute: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Formatters are expensive to construct; caching them is a pure optimisation
// (same zone -> same formatter) and keeps property tests fast.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  formatters.set(timeZone, created);
  return created;
}

/** True when Intl accepts the zone (invalid names throw a RangeError). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock parts of a UTC instant in the given zone. */
export function localParts(utcMinutes: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMinutes * MINUTE_MS));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: WEEKDAY_INDEX[read("weekday")] ?? 0,
  };
}

function naiveUtcMinutes(date: LocalDate, hour: number, minute: number): number {
  return Date.UTC(date.year, date.month - 1, date.day, hour, minute) / MINUTE_MS;
}

/** Offset (local − UTC) in minutes that the zone applies at the given instant. */
function offsetAt(utcMinutes: number, timeZone: string): number {
  const p = localParts(utcMinutes, timeZone);
  return naiveUtcMinutes(p, p.hour, p.minute) - utcMinutes;
}

/**
 * UTC instant for a local wall time. Ambiguous times (DST fall-back) resolve to
 * the earlier instant; non-existent times (DST spring-forward gap) shift forward
 * to the later instant, which is what calendar apps do with a 02:30 start.
 */
export function localToUtcMinutes(date: LocalDate, wall: WallTime, timeZone: string): number {
  const naive = naiveUtcMinutes(date, wall.hour, wall.minute);
  // Offsets observed one day around the target cover both sides of a transition.
  const probes = [naive, naive - MINUTES_PER_DAY, naive + MINUTES_PER_DAY];
  const candidates = new Set<number>();
  for (const probe of probes) candidates.add(naive - offsetAt(probe, timeZone));
  const exact = [...candidates].filter((t) => {
    const p = localParts(t, timeZone);
    return (
      p.year === date.year &&
      p.month === date.month &&
      p.day === date.day &&
      p.hour === wall.hour &&
      p.minute === wall.minute
    );
  });
  if (exact.length > 0) return Math.min(...exact);
  return Math.max(...candidates);
}

/** Parses "HH:MM"; null when malformed or out of range. */
export function parseWallTime(text: string): WallTime | null {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function wallToMinutes(wall: WallTime): number {
  return wall.hour * 60 + wall.minute;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday for a local calendar date. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** "YYYY-MM-DD" key used to group blocks and capacity by local day. */
export function localDateKey(date: LocalDate): string {
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${String(date.year)}-${mm}-${dd}`;
}

export function isoToMinutes(iso: string, rounding: "floor" | "ceil"): number {
  const ms = Date.parse(iso) / MINUTE_MS;
  return rounding === "floor" ? Math.floor(ms) : Math.ceil(ms);
}

export function minutesToIso(utcMinutes: number): string {
  return new Date(utcMinutes * MINUTE_MS).toISOString();
}

/** Wall-clock "minute of day" (0..1439) of an instant in the zone; handy for assertions. */
export function wallMinuteOfDay(utcMinutes: number, timeZone: string): number {
  const p = localParts(utcMinutes, timeZone);
  return p.hour * 60 + p.minute;
}
