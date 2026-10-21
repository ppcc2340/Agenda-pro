import { z } from "zod";
import type { CalendarEvent, CalendarProvider, CalendarSyncPage, MeriBlockInput } from "../calendar/types";
import { IntegrationError, type HealthReport } from "../errors";
import type { GoogleAccountRef } from "../oauth/types";
import { GoogleEvent, MERI_MARKER, mapGoogleEvent } from "./calendar-mapping";
import { GoogleHttp, type GoogleHttpOptions } from "./http";

const BASE = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 40;

/** Calendars that are not the user's own time (holidays, birthdays, week numbers): never synced as busy time. */
const NOT_OWN_TIME = /#(holiday|contacts|weeknum)@|addressbook#contacts@/;

const CalendarListEntry = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  primary: z.boolean().optional(),
  selected: z.boolean().optional(),
  accessRole: z.string().optional(),
  description: z.string().optional(),
});
const CalendarList = z.object({
  items: z.array(CalendarListEntry).default([]),
  nextPageToken: z.string().optional(),
});
const CalendarResource = z.object({ id: z.string().min(1), timeZone: z.string().optional() });
const EventsPage = z.object({
  items: z.array(GoogleEvent).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  timeZone: z.string().optional(),
});

const MERI_CALENDAR = { summary: "Meri", description: "Bloques de trabajo planificados por Meri." } as const;

/**
 * Live Google Calendar (docs/07, ADR 0008). Reads every calendar the user owns or writes and has selected; writes
 * only to the connection's dedicated «Meri» calendar and only to events carrying the Meri marker (checked by
 * reading the event first). The scope `calendar.app.created` makes Google enforce the same boundary.
 */
export class LiveGoogleCalendar implements CalendarProvider {
  readonly provider = "google" as const;
  private readonly http: GoogleHttp;
  private meriCalendarId: string | null;

  constructor(
    private readonly account: GoogleAccountRef,
    options: GoogleHttpOptions = {},
  ) {
    this.http = new GoogleHttp("google-calendar", options);
    this.meriCalendarId = account.meriCalendarId ?? null;
  }

  private get token() {
    return (o?: { forceRefresh?: boolean }) => this.account.accessToken(o);
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      await this.http.request(CalendarList, {
        url: `${BASE}/users/me/calendarList`,
        query: { maxResults: 1 },
        token: this.token,
      });
      return { provider: "google-calendar", mode: "live", status: "healthy" };
    } catch (err) {
      const kind = err instanceof IntegrationError ? err.kind : "Transient";
      return {
        provider: "google-calendar",
        mode: "live",
        status: kind === "AuthExpired" ? "needs_reauth" : "degraded",
        detail: kind,
      };
    }
  }

  async listCalendars(): Promise<{ id: string; name: string; primary: boolean }[]> {
    const out: { id: string; name: string; primary: boolean }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.http.request(CalendarList, {
        url: `${BASE}/users/me/calendarList`,
        query: { maxResults: 250, minAccessRole: "writer", pageToken },
        token: this.token,
      });
      for (const c of res.body?.items ?? []) {
        const meri = c.id === this.meriCalendarId;
        // Google omits `selected` when it is false: only calendars shown in the user's Google Calendar count.
        if (!meri && (NOT_OWN_TIME.test(c.id) || (c.selected !== true && c.primary !== true))) continue;
        out.push({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: c.primary === true });
      }
      pageToken = res.body?.nextPageToken;
      if (!pageToken) return out;
    }
    throw new IntegrationError("Permanent", "google-calendar", "too many calendar list pages");
  }

  async ensureMeriCalendar(): Promise<string> {
    if (this.meriCalendarId) {
      const existing = await this.http.request(CalendarResource, {
        url: `${BASE}/calendars/${encodeURIComponent(this.meriCalendarId)}`,
        token: this.token,
        allow: [404, 410],
      });
      if (existing.body) return existing.body.id;
    }
    // No remembered id (first write, or a reconnect that lost it): reuse Meri's own calendar if it already exists,
    // so reconnecting never piles up «Meri» calendars in the user's account.
    const found = await this.findMeriCalendar();
    if (found) {
      this.meriCalendarId = found;
      await this.account.rememberMeriCalendar?.(found);
      return found;
    }
    const created = await this.http.request(CalendarResource, {
      method: "POST",
      url: `${BASE}/calendars`,
      json: MERI_CALENDAR,
      token: this.token,
    });
    if (!created.body)
      throw new IntegrationError("Permanent", "google-calendar", "calendar creation returned nothing");
    this.meriCalendarId = created.body.id;
    await this.account.rememberMeriCalendar?.(created.body.id);
    return created.body.id;
  }

  private async findMeriCalendar(): Promise<string | null> {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.http.request(CalendarList, {
        url: `${BASE}/users/me/calendarList`,
        query: { maxResults: 250, minAccessRole: "owner", pageToken },
        token: this.token,
      });
      const mine = (res.body?.items ?? []).find(
        (c) => c.summary === MERI_CALENDAR.summary && c.description === MERI_CALENDAR.description,
      );
      if (mine) return mine.id;
      pageToken = res.body?.nextPageToken;
      if (!pageToken) return null;
    }
    return null;
  }

  async sync(input: {
    calendarId: string;
    cursor: string | null;
    from: string;
    to: string;
  }): Promise<CalendarSyncPage> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = input.cursor
        ? { syncToken: input.cursor, singleEvents: true, maxResults: 250, pageToken }
        : { timeMin: input.from, timeMax: input.to, singleEvents: true, maxResults: 250, pageToken };
      const res = await this.http.request(EventsPage, {
        url: `${BASE}/calendars/${encodeURIComponent(input.calendarId)}/events`,
        query,
        token: this.token,
        allow: [410],
      });
      // 410 Gone: the sync token expired; the caller drops this calendar's mirror and starts over.
      if (res.status === 410) return { events: [], nextCursor: null, fullResyncRequired: true };
      const body = res.body;
      if (!body) break;
      const zone = body.timeZone ?? "UTC";
      for (const raw of body.items) {
        const mapped = mapGoogleEvent(raw, input.calendarId, zone);
        // Meri's only if it carries the marker AND lives in Meri's calendar: a co-writer of a shared calendar
        // could set the marker on a real meeting (SEC-M8).
        if (mapped) events.push({ ...mapped, meri: mapped.meri && input.calendarId === this.meriCalendarId });
      }
      if (body.nextPageToken) {
        pageToken = body.nextPageToken;
        continue;
      }
      return { events, nextCursor: body.nextSyncToken ?? null, fullResyncRequired: false };
    }
    throw new IntegrationError("Permanent", "google-calendar", "too many event pages");
  }

  async createMeriEvent(calendarId: string, input: MeriBlockInput): Promise<CalendarEvent> {
    this.assertMeriCalendar(calendarId);
    const res = await this.http.request(GoogleEvent, {
      method: "POST",
      url: `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      json: {
        summary: input.title,
        ...(input.description ? { description: input.description } : {}),
        start: { dateTime: input.startsAt },
        end: { dateTime: input.endsAt },
        transparency: "opaque",
        reminders: { useDefault: false },
        extendedProperties: { private: { [MERI_MARKER.key]: MERI_MARKER.value } },
      },
      token: this.token,
    });
    return this.mapped(res.body, calendarId);
  }

  async updateMeriEvent(
    calendarId: string,
    externalId: string,
    input: Partial<MeriBlockInput>,
    etag: string | null,
  ): Promise<CalendarEvent> {
    const current = await this.requireMeri(calendarId, externalId);
    if (!current) throw new IntegrationError("Permanent", "google-calendar", `event ${externalId} not found`);
    const res = await this.http.request(GoogleEvent, {
      method: "PATCH",
      url: `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      json: {
        ...(input.title !== undefined ? { summary: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.startsAt !== undefined ? { start: { dateTime: input.startsAt } } : {}),
        ...(input.endsAt !== undefined ? { end: { dateTime: input.endsAt } } : {}),
      },
      // 412 (stale etag) is a Permanent failure: the caller re-syncs before trying again (ADR 0008).
      ...(etag ? { headers: { "if-match": etag } } : {}),
      token: this.token,
    });
    return this.mapped(res.body, calendarId);
  }

  async deleteMeriEvent(calendarId: string, externalId: string): Promise<void> {
    const current = await this.requireMeri(calendarId, externalId);
    // Already gone or cancelled: the goal is met (same as the fake).
    if (!current || current.status === "cancelled") return;
    await this.http.request(z.unknown(), {
      method: "DELETE",
      url: `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      token: this.token,
      allow: [404, 410],
    });
  }

  /** Writes only ever target the connection's own «Meri» calendar. */
  private assertMeriCalendar(calendarId: string): void {
    // Without a known Meri calendar nothing may be written (ensureMeriCalendar first).
    if (!this.meriCalendarId || calendarId !== this.meriCalendarId)
      throw new IntegrationError(
        "Permanent",
        "google-calendar",
        "refusing to write outside the Meri calendar",
      );
  }

  /** The current event when it is Meri's; null when it no longer exists; throws for anything else. */
  private async requireMeri(calendarId: string, externalId: string): Promise<CalendarEvent | null> {
    this.assertMeriCalendar(calendarId);
    const res = await this.http.request(GoogleEvent, {
      url: `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      token: this.token,
      allow: [404, 410],
    });
    if (!res.body) return null;
    const event = mapGoogleEvent(res.body, calendarId, "UTC");
    if (!event?.meri)
      throw new IntegrationError(
        "Permanent",
        "google-calendar",
        `refusing to modify non-Meri event ${externalId}`,
      );
    return event;
  }

  private mapped(body: GoogleEvent | null, calendarId: string): CalendarEvent {
    const event = body ? mapGoogleEvent(body, calendarId, "UTC") : null;
    if (!event) throw new IntegrationError("Permanent", "google-calendar", "unexpected event response");
    return event;
  }
}
