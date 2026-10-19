import { z } from "zod";
import type { HealthReport } from "../errors";

export const CalendarEvent = z.object({
  externalId: z.string(),
  calendarId: z.string(),
  etag: z.string().nullable(),
  title: z.string().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  allDay: z.boolean(),
  attendees: z.array(z.string()),
  busy: z.boolean(),
  /** True only for events Meri created (extendedProperties.private.meri=1). */
  meri: z.boolean(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export interface CalendarSyncPage {
  events: CalendarEvent[];
  /** Cursor for the next incremental call; null when a full resync is required (410 Gone). */
  nextCursor: string | null;
  fullResyncRequired: boolean;
}

export interface MeriBlockInput {
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
}

/**
 * Calendar connector (docs/07). Writes are restricted to events created by Meri: implementations MUST refuse to
 * update or delete events where `meri === false` (contract test in fakes/calendar.test.ts).
 */
export interface CalendarProvider {
  readonly provider: "google";
  healthCheck(): Promise<HealthReport>;
  listCalendars(): Promise<{ id: string; name: string; primary: boolean }[]>;
  /** Returns (or creates) the dedicated "Meri" calendar id. */
  ensureMeriCalendar(): Promise<string>;
  sync(input: { calendarId: string; cursor: string | null; from: string; to: string }): Promise<CalendarSyncPage>;
  createMeriEvent(calendarId: string, input: MeriBlockInput): Promise<CalendarEvent>;
  updateMeriEvent(calendarId: string, externalId: string, input: Partial<MeriBlockInput>, etag: string | null): Promise<CalendarEvent>;
  deleteMeriEvent(calendarId: string, externalId: string): Promise<void>;
}
