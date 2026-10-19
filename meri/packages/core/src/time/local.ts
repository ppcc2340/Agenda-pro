/**
 * Minimal time-zone helpers for core (no date libraries). All instants are ISO UTC strings or epoch ms;
 * wall-clock values are derived with Intl for an IANA zone.
 */
export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
}

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    cache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toLocalParts(epochMs: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** Epoch ms of a local wall-clock time in `timeZone` (handles DST by iterating the offset). */
export function fromLocalParts(
  p: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  let guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  for (let i = 0; i < 3; i++) {
    const local = toLocalParts(guess, timeZone);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** YYYY-MM-DD of the local day. */
export function localDateKey(epochMs: number, timeZone: string): string {
  const p = toLocalParts(epochMs, timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Adds whole days to a local date (year/month/day) without touching the hour. */
export function addLocalDays(
  p: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
