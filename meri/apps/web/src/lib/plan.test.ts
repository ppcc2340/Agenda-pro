import { describe, expect, it } from "vitest";
import { currentBlock, dayItems, dayKey, minuteOfDay, riskRows, startOfLocalDay, weekDays } from "./plan";
import type { Block, CalendarEvent } from "./types";

const TZ = "Europe/Madrid";
const block = (id: string, startsAt: string, endsAt: string, done = false): Block => ({
  id,
  taskId: `task-${id}`,
  startsAt,
  endsAt,
  pinned: false,
  reason: [],
  calendarEventId: null,
  planVersion: 1,
  completedAt: done ? endsAt : null,
});
const event = (
  id: string,
  startsAt: string,
  endsAt: string,
  origin: "external" | "meri" = "external",
): CalendarEvent => ({
  id,
  integrationAccountId: "acc",
  externalId: id,
  title: `Evento ${id}`,
  startsAt,
  endsAt,
  allDay: false,
  attendees: [],
  clientId: null,
  origin,
  busy: true,
});

describe("plan helpers", () => {
  it("computes local day keys and minutes in the user's time zone (DST-safe)", () => {
    expect(dayKey(new Date("2026-10-19T22:30:00Z"), TZ)).toBe("2026-10-20"); // 00:30 in Madrid
    expect(minuteOfDay("2026-10-19T10:40:00Z", TZ)).toBe(12 * 60 + 40);
    expect(startOfLocalDay(new Date("2026-10-19T10:40:00Z"), TZ).toISOString()).toBe(
      "2026-10-18T22:00:00.000Z",
    );
    // After the DST change (25 Oct 2026) Madrid is UTC+1.
    expect(startOfLocalDay(new Date("2026-10-26T10:00:00Z"), TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
    expect(minuteOfDay("2026-10-26T10:00:00Z", TZ)).toBe(11 * 60);
  });

  it("builds a Monday-based week of local day starts", () => {
    const days = weekDays(new Date("2026-10-21T15:00:00Z"), TZ); // Wednesday
    expect(days.map((d) => dayKey(d, TZ))).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(dayKey(weekDays(new Date("2026-10-25T12:00:00Z"), TZ)[0] ?? new Date(0), TZ)).toBe("2026-10-19"); // Sunday
  });

  it("lists the day's external events and blocks sorted, hiding Meri's mirrored events", () => {
    const tasks = new Map([["task-b1", { title: "Informe", clientId: "c1" }]]);
    const items = dayItems(
      new Date("2026-10-19T10:40:00Z"),
      TZ,
      [
        block("b1", "2026-10-19T13:00:00Z", "2026-10-19T14:00:00Z"),
        block("b2", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z"),
      ],
      [
        event("e1", "2026-10-19T07:30:00Z", "2026-10-19T08:00:00Z"),
        event("m1", "2026-10-19T09:00:00Z", "2026-10-19T10:00:00Z", "meri"),
      ],
      tasks,
    );
    expect(items.map((i) => [i.kind, i.title, i.startMin])).toEqual([
      ["event", "Evento e1", 9 * 60 + 30],
      ["block", "Informe", 15 * 60],
    ]);
    expect(items[1]?.clientId).toBe("c1");
  });

  it("picks the running block, else the next one, skipping done blocks", () => {
    const tasks = new Map<string, { title: string; clientId: string | null }>();
    const items = dayItems(
      new Date("2026-10-19T10:40:00Z"),
      TZ,
      [
        block("a", "2026-10-19T07:00:00Z", "2026-10-19T08:00:00Z", true),
        block("b", "2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z"),
        block("c", "2026-10-19T13:00:00Z", "2026-10-19T14:00:00Z"),
      ],
      [],
      tasks,
    );
    expect(currentBlock(items, 12 * 60 + 40)?.id).toBe("b");
    expect(currentBlock(items, 13 * 60 + 30)?.id).toBe("c");
    expect(currentBlock(items, 17 * 60)).toBeNull();
  });

  it("groups risks and conflicts into one row per task and points to the fix", () => {
    const task = (id: string) =>
      ({ id, title: `T ${id}`, clientId: null }) as unknown as Parameters<
        typeof riskRows
      >[0]["tasks"][number];
    const rows = riskRows({
      tasks: [task("a"), task("b")],
      risks: [{ taskId: "a", slackHours: 1.5, cause: "LOW_SLACK" }],
      conflicts: [{ code: "OVERLOAD", taskIds: ["a", "b"], details: {}, alternatives: ["move_other_task"] }],
      pendingProposal: null,
    });
    expect(rows.map((r) => [r.taskId, r.kind, r.code, r.fix])).toEqual([
      ["a", "risk", "LOW_SLACK", "replan"],
      ["b", "conflict", "OVERLOAD", "replan"],
    ]);
  });
});
