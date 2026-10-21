import { expect, it } from "vitest";
import type { CalendarProvider, MeriBlockInput } from "./types";

/**
 * Calendar connector contract (docs/07, ADR 0008), run against the fake AND the live adapter (simulated Google), so
 * switching GOOGLE_MODE changes no behaviour. Uses only the public interface plus a way to plant a third-party event.
 */
export interface CalendarContractSetup {
  calendar: CalendarProvider;
  /** Plants a meeting Meri did not create, in the user's main calendar. */
  addExternal: (input: MeriBlockInput) => Promise<{ calendarId: string; externalId: string }>;
}

const DAY = { from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" };
const block = (title: string): MeriBlockInput => ({
  title,
  startsAt: "2026-10-19T13:00:00Z",
  endsAt: "2026-10-19T15:00:00Z",
});

export function calendarContract(make: () => Promise<CalendarContractSetup>): void {
  it("keeps one dedicated Meri calendar", async () => {
    const { calendar } = await make();
    const first = await calendar.ensureMeriCalendar();
    expect(await calendar.ensureMeriCalendar()).toBe(first);
  });

  it("creates, syncs incrementally, updates with the etag and deletes its own events", async () => {
    const { calendar } = await make();
    const id = await calendar.ensureMeriCalendar();
    const ev = await calendar.createMeriEvent(id, block("Deep work"));
    expect(ev).toMatchObject({ meri: true, title: "Deep work", status: "confirmed", calendarId: id });
    const full = await calendar.sync({ calendarId: id, cursor: null, ...DAY });
    expect(full.events.map((e) => e.externalId)).toContain(ev.externalId);
    expect(full.fullResyncRequired).toBe(false);
    const quiet = await calendar.sync({ calendarId: id, cursor: full.nextCursor, ...DAY });
    expect(quiet.events).toHaveLength(0);
    await expect(
      calendar.updateMeriEvent(id, ev.externalId, { title: "x" }, '"stale"'),
    ).rejects.toMatchObject({
      kind: "Permanent",
    });
    const moved = await calendar.updateMeriEvent(id, ev.externalId, { title: "Deep work (moved)" }, ev.etag);
    expect(moved.title).toBe("Deep work (moved)");
    await calendar.deleteMeriEvent(id, ev.externalId);
    const after = await calendar.sync({ calendarId: id, cursor: quiet.nextCursor, ...DAY });
    expect(after.events.find((e) => e.externalId === ev.externalId)?.status).toBe("cancelled");
    // Deleting again, or deleting something that never existed, is done.
    await calendar.deleteMeriEvent(id, ev.externalId);
    await calendar.deleteMeriEvent(id, "missing-event");
  });

  it("never modifies or deletes a meeting it did not create", async () => {
    const { calendar, addExternal } = await make();
    const meeting = await addExternal({ ...block("Reunión con Acme"), startsAt: "2026-10-19T09:30:00Z" });
    await expect(
      calendar.updateMeriEvent(meeting.calendarId, meeting.externalId, { title: "hijack" }, null),
    ).rejects.toMatchObject({ kind: "Permanent" });
    await expect(calendar.deleteMeriEvent(meeting.calendarId, meeting.externalId)).rejects.toMatchObject({
      kind: "Permanent",
    });
    const seen = await calendar.sync({ calendarId: meeting.calendarId, cursor: null, ...DAY });
    expect(seen.events.find((e) => e.externalId === meeting.externalId)).toMatchObject({
      title: "Reunión con Acme",
      meri: false,
      status: "confirmed",
    });
  });

  it("asks for a full resync when the cursor is no longer valid", async () => {
    const { calendar } = await make();
    const id = await calendar.ensureMeriCalendar();
    const page = await calendar.sync({ calendarId: id, cursor: "expired-cursor", ...DAY });
    expect(page).toMatchObject({ fullResyncRequired: true, nextCursor: null, events: [] });
  });
}
