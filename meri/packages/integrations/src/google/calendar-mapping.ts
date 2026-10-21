import { z } from "zod";
import type { CalendarEvent } from "../calendar/types";

/** The subset of a Google Calendar event resource Meri reads (docs/07). Unknown fields are ignored. */
export const GoogleEvent = z.object({
  id: z.string().min(1),
  etag: z.string().optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  summary: z.string().optional(),
  transparency: z.enum(["opaque", "transparent"]).optional(),
  start: z
    .object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() })
    .optional(),
  end: z
    .object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() })
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        self: z.boolean().optional(),
        resource: z.boolean().optional(),
      }),
    )
    .optional(),
  extendedProperties: z.object({ private: z.record(z.string()).optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEvent>;

/** Marker on events Meri creates (docs/07): only these may ever be modified or deleted. */
export const MERI_MARKER = { key: "meri", value: "1" } as const;

/** Incremental syncs return cancelled events with only their id: the sync job only needs the id to remove them. */
const CANCELLED_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset (ms) of `timeZone` at the instant `utcMs`. */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Local midnight of an all-day date in the calendar's time zone, as a UTC instant (all-day events are dates, not
 * instants). Two passes settle the offset around DST changes; an invalid zone falls back to UTC.
 */
export function localMidnightIso(date: string, timeZone: string): string {
  const m = DATE.exec(date);
  if (!m) throw new Error(`invalid all-day date ${date}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    let utc = guess - offsetMs(guess, timeZone);
    utc = guess - offsetMs(utc, timeZone);
    return new Date(utc).toISOString();
  } catch {
    return new Date(guess).toISOString();
  }
}

function instant(
  t: { dateTime?: string | undefined; date?: string | undefined } | undefined,
  timeZone: string,
): string | null {
  if (t?.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (t?.date && DATE.test(t.date)) return localMidnightIso(t.date, timeZone);
  return null;
}

/**
 * Google event → CalendarEvent. Returns null for a malformed non-cancelled event (no usable start/end): it is
 * skipped rather than stored with invented times.
 */
export function mapGoogleEvent(
  raw: GoogleEvent,
  calendarId: string,
  calendarTimeZone: string,
): CalendarEvent | null {
  const status = raw.status ?? "confirmed";
  const meri = raw.extendedProperties?.private?.[MERI_MARKER.key] === MERI_MARKER.value;
  if (status === "cancelled")
    return {
      externalId: raw.id,
      calendarId,
      etag: raw.etag ?? null,
      title: null,
      startsAt: CANCELLED_PLACEHOLDER,
      endsAt: CANCELLED_PLACEHOLDER,
      allDay: false,
      attendees: [],
      busy: false,
      meri,
      status,
    };
  const zone = raw.start?.timeZone ?? calendarTimeZone;
  const startsAt = instant(raw.start, zone);
  const endsAt = instant(raw.end, raw.end?.timeZone ?? zone);
  if (!startsAt || !endsAt || endsAt < startsAt) return null;
  return {
    externalId: raw.id,
    calendarId,
    etag: raw.etag ?? null,
    title: raw.summary ?? null,
    startsAt,
    endsAt,
    allDay: !raw.start?.dateTime && Boolean(raw.start?.date),
    // People only: meeting rooms and the calendar owner are not counterparts (D-040 client resolution).
    attendees: (raw.attendees ?? [])
      .filter((a) => !a.resource && !a.self && a.email)
      .map((a) => (a.email ?? "").toLowerCase()),
    busy: raw.transparency !== "transparent",
    meri,
    status,
  };
}
