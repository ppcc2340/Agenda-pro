import type { MeriBlockInput } from "../calendar/types";
import { SimulatedGoogle, type RecordedRequest } from "./test-server";

interface SimEvent {
  id: string;
  calendarId: string;
  version: number;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status: "confirmed" | "cancelled";
  extendedProperties?: { private?: Record<string, string> };
  attendees?: { email: string; self?: boolean }[];
}

/**
 * Stateful Google Calendar v3 for tests (ADR 0008): calendar list, calendar creation, event CRUD with etags and
 * If-Match (412), syncToken-based incremental listing with 410 on unknown tokens, and pagination (page size 2, so
 * the adapter's paging is exercised). Behaviour follows Google's documented semantics.
 */
export class SimulatedGoogleCalendar extends SimulatedGoogle {
  private version = 0;
  private counter = 0;
  readonly calendars = new Map<
    string,
    { summary: string; primary: boolean; accessRole: string; description?: string; selected?: boolean }
  >([
    ["ana@acme.test", { summary: "ana@acme.test", primary: true, accessRole: "owner" }],
    [
      "es.spain#holiday@group.v.calendar.google.com",
      { summary: "Festivos", primary: false, accessRole: "reader" },
    ],
  ]);
  readonly events = new Map<string, SimEvent>();
  readonly primaryId = "ana@acme.test";

  constructor() {
    super();
    const base = "/calendar/v3";
    this.on("GET", `${base}/users/me/calendarList`, (req) => {
      const minRole = req.url.searchParams.get("minAccessRole");
      const items = [...this.calendars.entries()]
        .filter(([, c]) => minRole !== "writer" || c.accessRole === "owner" || c.accessRole === "writer")
        .filter(([, c]) => minRole !== "owner" || c.accessRole === "owner")
        .map(([id, c]) => ({
          id,
          summary: c.summary,
          primary: c.primary,
          accessRole: c.accessRole,
          ...(c.description ? { description: c.description } : {}),
          // Like Google: `selected` is omitted when the calendar is hidden.
          ...(c.selected === false ? {} : { selected: true }),
        }));
      return { json: { items } };
    });
    this.on("POST", `${base}/calendars`, (req) => {
      const body = JSON.parse(req.body) as { summary: string; description?: string };
      const id = `meri-${String(++this.counter)}@group.calendar.google.com`;
      this.calendars.set(id, {
        summary: body.summary,
        primary: false,
        accessRole: "owner",
        ...(body.description ? { description: body.description } : {}),
      });
      return { json: { id, summary: body.summary } };
    });
    this.on("GET", new RegExp(`^${base}/calendars/[^/]+$`), (req) => {
      const id = this.calendarOf(req);
      return this.calendars.has(id) ? { json: { id } } : { status: 404, json: { error: { code: 404 } } };
    });
    this.on("GET", new RegExp(`^${base}/calendars/[^/]+/events$`), (req) => this.list(req));
    this.on("POST", new RegExp(`^${base}/calendars/[^/]+/events$`), (req) => {
      const calendarId = this.calendarOf(req);
      if (!this.calendars.has(calendarId)) return { status: 404, json: { error: { code: 404 } } };
      const body = JSON.parse(req.body) as Omit<SimEvent, "id" | "calendarId" | "version" | "status">;
      const ev: SimEvent = {
        ...body,
        id: `ev${String(++this.counter)}`,
        calendarId,
        version: ++this.version,
        status: "confirmed",
      };
      this.events.set(ev.id, ev);
      return { json: this.resource(ev) };
    });
    this.on("GET", new RegExp(`^${base}/calendars/[^/]+/events/[^/]+$`), (req) => {
      const ev = this.eventOf(req);
      return ev ? { json: this.resource(ev) } : { status: 404, json: { error: { code: 404 } } };
    });
    this.on("PATCH", new RegExp(`^${base}/calendars/[^/]+/events/[^/]+$`), (req) => {
      const ev = this.eventOf(req);
      if (!ev) return { status: 404, json: { error: { code: 404 } } };
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== this.etag(ev))
        return { status: 412, json: { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } } };
      Object.assign(ev, JSON.parse(req.body), { version: ++this.version });
      return { json: this.resource(ev) };
    });
    this.on("DELETE", new RegExp(`^${base}/calendars/[^/]+/events/[^/]+$`), (req) => {
      const ev = this.eventOf(req);
      if (!ev || ev.status === "cancelled") return { status: 410, json: { error: { code: 410 } } };
      Object.assign(ev, { status: "cancelled", version: ++this.version });
      return { status: 204 };
    });
  }

  /** A meeting the user (not Meri) created in their main calendar. */
  addExternal(input: MeriBlockInput): { calendarId: string; externalId: string } {
    const ev: SimEvent = {
      id: `ext${String(++this.counter)}`,
      calendarId: this.primaryId,
      version: ++this.version,
      summary: input.title,
      start: { dateTime: input.startsAt },
      end: { dateTime: input.endsAt },
      status: "confirmed",
      attendees: [{ email: "ana@acme.test", self: true }, { email: "luis@cliente.test" }],
    };
    this.events.set(ev.id, ev);
    return { calendarId: ev.calendarId, externalId: ev.id };
  }

  private etag(ev: SimEvent): string {
    return `"${String(ev.version)}"`;
  }

  private resource(ev: SimEvent): Record<string, unknown> {
    const { version: _v, calendarId: _c, ...rest } = ev;
    return { ...rest, etag: this.etag(ev) };
  }

  private calendarOf(req: RecordedRequest): string {
    return decodeURIComponent(req.url.pathname.split("/")[4] ?? "");
  }

  private eventOf(req: RecordedRequest): SimEvent | undefined {
    const id = decodeURIComponent(req.url.pathname.split("/")[6] ?? "");
    const ev = this.events.get(id);
    return ev && ev.calendarId === this.calendarOf(req) ? ev : undefined;
  }

  private list(req: RecordedRequest) {
    const calendarId = this.calendarOf(req);
    const q = req.url.searchParams;
    const syncToken = q.get("syncToken");
    let selected: SimEvent[];
    if (syncToken) {
      const m = /^v(\d+)$/.exec(syncToken);
      if (!m)
        return { status: 410, json: { error: { code: 410, errors: [{ reason: "fullSyncRequired" }] } } };
      const since = Number(m[1]);
      selected = [...this.events.values()].filter((e) => e.calendarId === calendarId && e.version > since);
    } else {
      const from = q.get("timeMin") ?? "";
      const to = q.get("timeMax") ?? "￿";
      selected = [...this.events.values()].filter(
        (e) =>
          e.calendarId === calendarId &&
          e.status !== "cancelled" &&
          (e.end.dateTime ?? e.end.date ?? "") >= from &&
          (e.start.dateTime ?? e.start.date ?? "") <= to,
      );
    }
    const offset = Number(q.get("pageToken") ?? 0);
    const page = selected.slice(offset, offset + 2);
    const more = offset + 2 < selected.length;
    return {
      json: {
        timeZone: "Europe/Madrid",
        items: page.map((e) =>
          e.status === "cancelled" ? { id: e.id, status: "cancelled" } : this.resource(e),
        ),
        ...(more ? { nextPageToken: String(offset + 2) } : { nextSyncToken: `v${String(this.version)}` }),
      },
    };
  }
}
