import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inferTimeEntries, isoWeekKey, isoWeekRange, roundMinutes, type InferBlock, type InferEvent } from "./infer";

const TZ = "Europe/Madrid";
const NOW = "2026-10-19T10:40:00.000Z";
const ev = (id: string, start: string, end: string, extra: Partial<InferEvent> = {}): InferEvent => ({
  id,
  clientId: "acme",
  title: `Reunión ${id}`,
  startsAt: start,
  endsAt: end,
  allDay: false,
  busy: true,
  origin: "external",
  ...extra,
});
const block = (id: string, start: string, end: string, extra: Partial<InferBlock> = {}): InferBlock => ({
  id,
  taskId: `task-${id}`,
  taskTitle: `Tarea ${id}`,
  clientId: "acme",
  startsAt: start,
  endsAt: end,
  completedAt: NOW,
  ...extra,
});

describe("time inference rules (D-042, F-10)", () => {
  it("rounds up to the unit, never below one unit", () => {
    expect(roundMinutes(1, 6)).toBe(6);
    expect(roundMinutes(6, 6)).toBe(6);
    expect(roundMinutes(61, 6)).toBe(66);
    expect(roundMinutes(0, 15)).toBe(15);
    expect(roundMinutes(46, 15)).toBe(60);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1440 }), fc.constantFrom<6 | 15>(6, 15), (m, step) => {
        const r = roundMinutes(m, step);
        expect(r % step).toBe(0);
        expect(r).toBeGreaterThanOrEqual(Math.max(m, step));
        expect(r - m).toBeLessThan(step + 1);
      }),
    );
  });

  it("infers ended external client events and completed client blocks; the block wins on overlap", () => {
    const out = inferTimeEntries({
      now: NOW,
      timezone: TZ,
      roundingMinutes: 6,
      events: [
        ev("e-ended", "2026-10-19T07:00:00.000Z", "2026-10-19T07:50:00.000Z"),
        ev("e-future", "2026-10-19T12:00:00.000Z", "2026-10-19T13:00:00.000Z"),
        ev("e-noclient", "2026-10-18T09:00:00.000Z", "2026-10-18T09:30:00.000Z", { clientId: null }),
        ev("e-allday", "2026-10-18T00:00:00.000Z", "2026-10-19T00:00:00.000Z", { allDay: true }),
        ev("e-free", "2026-10-18T10:00:00.000Z", "2026-10-18T10:30:00.000Z", { busy: false }),
        ev("e-meri", "2026-10-18T11:00:00.000Z", "2026-10-18T12:00:00.000Z", { origin: "meri" }),
        ev("e-covered", "2026-10-16T09:00:00.000Z", "2026-10-16T10:00:00.000Z"),
        ev("e-partial", "2026-10-15T09:00:00.000Z", "2026-10-15T10:00:00.000Z"),
      ],
      blocks: [
        block("b-done", "2026-10-16T09:00:00.000Z", "2026-10-16T09:45:00.000Z"),
        block("b-partial", "2026-10-15T09:00:00.000Z", "2026-10-15T09:20:00.000Z"),
        block("b-open", "2026-10-17T09:00:00.000Z", "2026-10-17T10:00:00.000Z", { completedAt: null }),
        block("b-noclient", "2026-10-17T11:00:00.000Z", "2026-10-17T12:00:00.000Z", { clientId: null }),
        block("b-other", "2026-10-16T09:00:00.000Z", "2026-10-16T10:00:00.000Z", { clientId: "beta" }),
      ],
    });
    expect(out.entries.map((e) => `${e.sourceType}:${e.sourceId}:${e.day}:${String(e.minutes)}`)).toEqual([
      "schedule_block:b-partial:2026-10-15:24",
      "calendar_event:e-partial:2026-10-15:60",
      "schedule_block:b-done:2026-10-16:48",
      "schedule_block:b-other:2026-10-16:60",
      "calendar_event:e-ended:2026-10-19:54",
    ]);
    expect(out.unassignedEventIds).toEqual(["e-noclient"]);
    expect(out.entries.find((e) => e.sourceId === "e-ended")?.description).toBe("Reunión e-ended");
  });

  it("is deterministic and never produces two entries for the same source", () => {
    const arbIso = fc.integer({ min: Date.parse("2026-10-01T00:00:00Z"), max: Date.parse("2026-10-19T10:00:00Z") });
    const arbEvent = fc
      .record({ id: fc.uuid(), s: arbIso, d: fc.integer({ min: 1, max: 180 }), c: fc.option(fc.constantFrom("a", "b"), { nil: null }) })
      .map((r) => ev(r.id, new Date(r.s).toISOString(), new Date(r.s + r.d * 60_000).toISOString(), { clientId: r.c }));
    const arbBlock = fc
      .record({ id: fc.uuid(), s: arbIso, d: fc.integer({ min: 1, max: 180 }), c: fc.option(fc.constantFrom("a", "b"), { nil: null }), done: fc.boolean() })
      .map((r) => block(r.id, new Date(r.s).toISOString(), new Date(r.s + r.d * 60_000).toISOString(), { clientId: r.c, completedAt: r.done ? NOW : null }));
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 20 }), fc.array(arbBlock, { maxLength: 20 }), (events, blocks) => {
        const input = { now: NOW, timezone: TZ, roundingMinutes: 6 as const, events, blocks };
        const a = inferTimeEntries(input);
        expect(inferTimeEntries(input)).toEqual(a);
        const keys = a.entries.map((e) => `${e.sourceType}:${e.sourceId}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const e of a.entries) {
          expect(e.minutes % 6).toBe(0);
          expect(e.minutes).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("computes ISO weeks Monday–Sunday in the user's time zone", () => {
    expect(isoWeekKey(Date.parse("2026-10-19T10:40:00Z"), TZ)).toBe("2026-W43");
    // DST ended on 25 Oct 2026 (Madrid = UTC+1): 22:30 UTC is still Sunday 23:30 locally; 23:30 UTC is Monday.
    expect(isoWeekKey(Date.parse("2026-10-25T22:30:00Z"), TZ)).toBe("2026-W43");
    expect(isoWeekKey(Date.parse("2026-10-25T23:30:00Z"), TZ)).toBe("2026-W44");
    const w = isoWeekRange("2026-W43", TZ);
    expect(w?.days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(w?.from.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(w?.to.toISOString()).toBe("2026-10-25T23:00:00.000Z"); // DST ended on 25 Oct: Monday 00:00 CET = 23:00 UTC
    expect(isoWeekRange("2026-W01", "UTC")?.days[0]).toBe("2025-12-29");
    expect(isoWeekRange("2021-W01", "UTC")?.days[0]).toBe("2021-01-04");
    expect(isoWeekRange("2026-13", TZ)).toBeNull();
    expect(isoWeekRange("2026-W60", TZ)).toBeNull();
  });
});
