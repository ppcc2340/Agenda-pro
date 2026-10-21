import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { calendarContract } from "../calendar/contract";
import type { GoogleAccountRef } from "../oauth/types";
import { LiveGoogleCalendar } from "./calendar";
import { localMidnightIso, mapGoogleEvent } from "./calendar-mapping";
import { SimulatedGoogleCalendar } from "./calendar-simulator";

const account = (overrides: Partial<GoogleAccountRef> = {}): GoogleAccountRef => ({
  email: "ana@acme.test",
  accessToken: () => Promise.resolve("token-1"),
  ...overrides,
});

function live(sim = new SimulatedGoogleCalendar(), ref: Partial<GoogleAccountRef> = {}) {
  const remembered: string[] = [];
  const calendar = new LiveGoogleCalendar(
    account({ rememberMeriCalendar: (id) => Promise.resolve(void remembered.push(id)), ...ref }),
    { fetch: sim.fetch },
  );
  return { sim, calendar, remembered };
}

describe("LiveGoogleCalendar contract (simulated Google)", () => {
  calendarContract(() => {
    const { sim, calendar } = live();
    return Promise.resolve({ calendar, addExternal: (input) => Promise.resolve(sim.addExternal(input)) });
  });
});

describe("LiveGoogleCalendar specifics", () => {
  it("reuses its own «Meri» calendar after a reconnect instead of creating another one (review L7)", async () => {
    const sim = new SimulatedGoogleCalendar();
    const first = live(sim);
    const id = await first.calendar.ensureMeriCalendar();
    // A new connection that lost the stored id (disconnect + reconnect).
    const again = live(sim, { meriCalendarId: null });
    expect(await again.calendar.ensureMeriCalendar()).toBe(id);
    expect(again.remembered).toEqual([id]);
    expect(
      sim.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/calendars")),
    ).toHaveLength(1);
  });

  it("skips hidden calendars, and a marker outside the Meri calendar is not Meri's (review L8, SEC-M8)", async () => {
    const sim = new SimulatedGoogleCalendar();
    sim.calendars.set("hidden@group.calendar.google.com", {
      summary: "Oculto",
      primary: false,
      accessRole: "owner",
      selected: false,
    });
    const { calendar } = live(sim);
    const meriId = await calendar.ensureMeriCalendar();
    expect((await calendar.listCalendars()).map((c) => c.id)).toEqual([sim.primaryId, meriId]);
    // A co-writer sets the Meri marker on a real meeting in the primary calendar.
    const forged = sim.addExternal({
      title: "Reunión real",
      startsAt: "2026-10-21T10:00:00.000Z",
      endsAt: "2026-10-21T11:00:00.000Z",
    });
    const ev = sim.events.get(forged.externalId);
    if (ev) ev.extendedProperties = { private: { meri: "1" } };
    const page = await calendar.sync({
      calendarId: sim.primaryId,
      cursor: null,
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z",
    });
    expect(page.events.find((e) => e.externalId === forged.externalId)?.meri).toBe(false);
    // And nothing can be written before the Meri calendar is known.
    const fresh = live(sim, { meriCalendarId: null }).calendar;
    await expect(
      fresh.createMeriEvent(sim.primaryId, {
        title: "x",
        startsAt: "2026-10-21T10:00:00.000Z",
        endsAt: "2026-10-21T11:00:00.000Z",
      }),
    ).rejects.toMatchObject({ kind: "Permanent" });
  });

  it("creates the Meri calendar once, remembers it, and recreates it only if it disappeared", async () => {
    const { sim, calendar, remembered } = live();
    const id = await calendar.ensureMeriCalendar();
    expect(remembered).toEqual([id]);
    expect(await calendar.ensureMeriCalendar()).toBe(id);
    expect(
      sim.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/calendars")),
    ).toHaveLength(1);
    // A stored id that Google no longer knows: a new calendar is created and remembered.
    const again = live(sim, { meriCalendarId: "deleted@group.calendar.google.com" });
    const fresh = await again.calendar.ensureMeriCalendar();
    expect(fresh).not.toBe("deleted@group.calendar.google.com");
    expect(again.remembered).toEqual([fresh]);
  });

  it("lists the user's own writable calendars, never holidays or read-only ones", async () => {
    const { calendar } = live();
    const id = await calendar.ensureMeriCalendar();
    const cals = await calendar.listCalendars();
    expect(cals.map((c) => c.id).sort()).toEqual(["ana@acme.test", id].sort());
    expect(cals.find((c) => c.primary)?.id).toBe("ana@acme.test");
  });

  it("pages through events, maps attendees without the owner, and keeps the sync token", async () => {
    const { sim, calendar } = live();
    for (let i = 0; i < 5; i++)
      sim.addExternal({
        title: `Reunión ${String(i)}`,
        startsAt: "2026-10-19T09:00:00Z",
        endsAt: "2026-10-19T10:00:00Z",
      });
    const page = await calendar.sync({
      calendarId: sim.primaryId,
      cursor: null,
      from: "2026-10-19T00:00:00Z",
      to: "2026-10-20T00:00:00Z",
    });
    expect(page.events).toHaveLength(5);
    expect(page.events[0]?.attendees).toEqual(["luis@cliente.test"]);
    expect(page.nextCursor).toMatch(/^v\d+$/);
    // Three pages of two, the token only from the last one.
    expect(sim.requests.filter((r) => r.url.pathname.endsWith("/events"))).toHaveLength(3);
  });

  it("writes only to the remembered Meri calendar, and never sends a token in the URL", async () => {
    const { calendar, sim } = live(new SimulatedGoogleCalendar(), { meriCalendarId: null });
    const id = await calendar.ensureMeriCalendar();
    await expect(
      calendar.createMeriEvent(sim.primaryId, {
        title: "x",
        startsAt: "2026-10-19T13:00:00Z",
        endsAt: "2026-10-19T14:00:00Z",
      }),
    ).rejects.toThrow(/outside the Meri calendar/);
    await calendar.createMeriEvent(id, {
      title: "Bloque",
      startsAt: "2026-10-19T13:00:00Z",
      endsAt: "2026-10-19T14:00:00Z",
    });
    for (const r of sim.requests) {
      expect(r.url.search).not.toContain("token-1");
      expect(r.headers.authorization).toBe("Bearer token-1");
    }
  });
});

describe("Google event mapping", () => {
  it("all-day dates become local midnight in the calendar's zone, also across DST", () => {
    expect(localMidnightIso("2026-10-21", "Europe/Madrid")).toBe("2026-10-20T22:00:00.000Z");
    expect(localMidnightIso("2026-10-25", "Europe/Madrid")).toBe("2026-10-24T22:00:00.000Z");
    expect(localMidnightIso("2026-10-26", "Europe/Madrid")).toBe("2026-10-25T23:00:00.000Z");
    expect(localMidnightIso("2026-10-21", "America/Santiago")).toBe("2026-10-21T03:00:00.000Z");
    expect(localMidnightIso("2026-10-21", "Not/AZone")).toBe("2026-10-21T00:00:00.000Z");
    const ev = mapGoogleEvent(
      { id: "a", start: { date: "2026-10-21" }, end: { date: "2026-10-22" }, transparency: "transparent" },
      "c",
      "Europe/Madrid",
    );
    expect(ev).toMatchObject({
      allDay: true,
      busy: false,
      startsAt: "2026-10-20T22:00:00.000Z",
      endsAt: "2026-10-21T22:00:00.000Z",
    });
  });

  it("never throws and never produces an inverted or unparsable range", () => {
    const zones = fc.constantFrom(
      "UTC",
      "Europe/Madrid",
      "America/New_York",
      "America/Santiago",
      "Asia/Kolkata",
      "Pacific/Auckland",
    );
    const dateTime = fc.oneof(
      fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") }).map((d) => d.toISOString()),
      fc.string({ maxLength: 30 }),
    );
    const date = fc.oneof(
      fc
        .date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") })
        .map((d) => d.toISOString().slice(0, 10)),
      fc.string({ maxLength: 12 }),
    );
    const side = fc.oneof(fc.record({ dateTime }), fc.record({ date }), fc.constant({}));
    fc.assert(
      fc.property(
        side,
        side,
        zones,
        fc.constantFrom<"confirmed" | "tentative" | "cancelled">("confirmed", "tentative", "cancelled"),
        (start, end, zone, status) => {
          const ev = mapGoogleEvent({ id: "x", start, end, status }, "c", zone);
          if (ev === null) return;
          expect(Number.isNaN(Date.parse(ev.startsAt))).toBe(false);
          expect(Number.isNaN(Date.parse(ev.endsAt))).toBe(false);
          if (status !== "cancelled") expect(ev.endsAt >= ev.startsAt).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
