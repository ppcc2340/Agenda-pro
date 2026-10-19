import { IntegrationError, type HealthReport } from "../errors";
import type { CalendarEvent, CalendarProvider, CalendarSyncPage, MeriBlockInput } from "../calendar/types";

export interface FakeCalendarOptions {
  /** Injected clock for deterministic ids/etags. */
  now: () => Date;
  seedEvents?: CalendarEvent[];
}

/**
 * In-memory Google Calendar stand-in. Deterministic (ids from a counter), honours the write contract:
 * only `meri` events can be modified or deleted.
 */
export class FakeCalendar implements CalendarProvider {
  readonly provider = "google" as const;
  readonly events = new Map<string, CalendarEvent>();
  private counter = 0;
  private version = 0;
  private readonly now: () => Date;
  readonly meriCalendarId = "meri";
  readonly primaryCalendarId = "primary";

  constructor(options: FakeCalendarOptions) {
    this.now = options.now;
    for (const e of options.seedEvents ?? []) this.events.set(e.externalId, e);
  }

  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({
      provider: "google-calendar",
      mode: "fake",
      status: "healthy",
      detail: "FakeCalendar",
    });
  }

  listCalendars(): Promise<{ id: string; name: string; primary: boolean }[]> {
    return Promise.resolve([
      { id: this.primaryCalendarId, name: "Principal", primary: true },
      { id: this.meriCalendarId, name: "Meri", primary: false },
    ]);
  }

  ensureMeriCalendar(): Promise<string> {
    return Promise.resolve(this.meriCalendarId);
  }

  /** Cursor = version number; events changed after the cursor are returned. */
  sync(input: {
    calendarId: string;
    cursor: string | null;
    from: string;
    to: string;
  }): Promise<CalendarSyncPage> {
    const since = input.cursor ? Number(input.cursor) : -1;
    if (Number.isNaN(since))
      return Promise.resolve({ events: [], nextCursor: null, fullResyncRequired: true });
    const events = [...this.events.values()].filter(
      (e) =>
        e.calendarId === input.calendarId &&
        Number(e.etag) > since &&
        e.endsAt >= input.from &&
        e.startsAt <= input.to,
    );
    return Promise.resolve({ events, nextCursor: String(this.version), fullResyncRequired: false });
  }

  createMeriEvent(calendarId: string, input: MeriBlockInput): Promise<CalendarEvent> {
    const event: CalendarEvent = {
      externalId: `fake-ev-${String(++this.counter)}`,
      calendarId,
      etag: String(++this.version),
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: false,
      attendees: [],
      busy: true,
      meri: true,
      status: "confirmed",
    };
    this.events.set(event.externalId, event);
    return Promise.resolve(event);
  }

  updateMeriEvent(
    calendarId: string,
    externalId: string,
    input: Partial<MeriBlockInput>,
    etag: string | null,
  ): Promise<CalendarEvent> {
    const current = this.requireMeri(calendarId, externalId);
    if (current instanceof IntegrationError) return Promise.reject(current);
    if (etag !== null && current.etag !== etag) {
      return Promise.reject(
        new IntegrationError("Transient", "google-calendar", "412 Precondition Failed: etag mismatch"),
      );
    }
    const updated: CalendarEvent = {
      ...current,
      title: input.title ?? current.title,
      startsAt: input.startsAt ?? current.startsAt,
      endsAt: input.endsAt ?? current.endsAt,
      etag: String(++this.version),
    };
    this.events.set(externalId, updated);
    return Promise.resolve(updated);
  }

  deleteMeriEvent(calendarId: string, externalId: string): Promise<void> {
    const current = this.requireMeri(calendarId, externalId);
    if (current instanceof IntegrationError) return Promise.reject(current);
    this.events.set(externalId, { ...current, status: "cancelled", etag: String(++this.version) });
    return Promise.resolve();
  }

  /** Test helper: simulate an external (non-Meri) event, e.g. a meeting created by the user in Google. */
  addExternalEvent(input: MeriBlockInput & { attendees?: string[]; calendarId?: string }): CalendarEvent {
    const event: CalendarEvent = {
      externalId: `ext-ev-${String(++this.counter)}`,
      calendarId: input.calendarId ?? this.primaryCalendarId,
      etag: String(++this.version),
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: false,
      attendees: input.attendees ?? [],
      busy: true,
      meri: false,
      status: "confirmed",
    };
    this.events.set(event.externalId, event);
    return event;
  }

  /** Write guard: returns the error as a value so callers reject instead of throwing synchronously. */
  private requireMeri(calendarId: string, externalId: string): CalendarEvent | IntegrationError {
    const current = this.events.get(externalId);
    if (!current || current.calendarId !== calendarId) {
      return new IntegrationError("Permanent", "google-calendar", `event ${externalId} not found`);
    }
    if (!current.meri) {
      return new IntegrationError(
        "Permanent",
        "google-calendar",
        `refusing to modify non-Meri event ${externalId}`,
      );
    }
    return current;
  }

  /** Exposed for tests of the injected clock. */
  currentTime(): Date {
    return this.now();
  }
}
