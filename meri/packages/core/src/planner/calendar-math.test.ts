import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  isValidTimeZone,
  isoToMinutes,
  localDateKey,
  localParts,
  localToUtcMinutes,
  minutesToIso,
  parseWallTime,
  wallMinuteOfDay,
  weekdayOf,
} from "./calendar-math";
import { computeDailyCapacity } from "./capacity";
import { TIMEZONES, demoInput } from "./fixtures";

const minutes = (iso: string): number => isoToMinutes(iso, "floor");

describe("calendar-math", () => {
  it("converts instants to local wall-clock parts", () => {
    expect(localParts(minutes("2026-10-19T07:00:00.000Z"), "Europe/Madrid")).toEqual({ year: 2026, month: 10, day: 19, hour: 9, minute: 0, weekday: 1 });
    expect(localParts(minutes("2026-10-19T00:30:00.000Z"), "America/Santiago")).toMatchObject({ day: 18, hour: 21, minute: 30, weekday: 0 });
    expect(wallMinuteOfDay(minutes("2026-10-19T07:00:00.000Z"), "Europe/Madrid")).toBe(540);
  });

  it("shifts forward through the spring DST gap and picks the first occurrence in the fall-back overlap", () => {
    // Madrid 2026-03-29: 02:00 → 03:00. 02:30 does not exist → 03:30 CEST = 01:30Z.
    const gap = localToUtcMinutes({ year: 2026, month: 3, day: 29 }, { hour: 2, minute: 30 }, "Europe/Madrid");
    expect(minutesToIso(gap)).toBe("2026-03-29T01:30:00.000Z");
    // Madrid 2026-10-25: 03:00 → 02:00. 02:30 happens twice → the earlier one (CEST) = 00:30Z.
    const overlap = localToUtcMinutes({ year: 2026, month: 10, day: 25 }, { hour: 2, minute: 30 }, "Europe/Madrid");
    expect(minutesToIso(overlap)).toBe("2026-10-25T00:30:00.000Z");
    // Santiago 2026-04-05: 00:00 → 23:00 on the 4th; 23:30 happens twice → earlier one (UTC−3).
    const chile = localToUtcMinutes({ year: 2026, month: 4, day: 4 }, { hour: 23, minute: 30 }, "America/Santiago");
    expect(minutesToIso(chile)).toBe("2026-04-05T02:30:00.000Z");
  });

  it("round-trips local parts for arbitrary instants in every supported zone", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TIMEZONES), fc.integer({ min: minutes("2026-01-01T00:00:00.000Z"), max: minutes("2026-12-31T00:00:00.000Z") }), (tz, t) => {
        const p = localParts(t, tz);
        const back = localToUtcMinutes(p, { hour: p.hour, minute: p.minute }, tz);
        // Either the same instant or, inside a fall-back overlap, the earlier occurrence (one hour before).
        expect([t, t - 60]).toContain(back);
      }),
      { numRuns: 500 },
    );
  });

  it("validates zones and wall times", () => {
    expect(isValidTimeZone("America/Santiago")).toBe(true);
    expect(isValidTimeZone("Nowhere/City")).toBe(false);
    expect(parseWallTime("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseWallTime("24:00")).toBeNull();
    expect(parseWallTime("9:30")).toBeNull();
  });

  it("walks local dates across month and year boundaries", () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(localDateKey({ year: 2026, month: 3, day: 9 })).toBe("2026-03-09");
    expect(weekdayOf({ year: 2026, month: 10, day: 19 })).toBe(1);
  });

  it("rounds ISO instants to minutes in the requested direction", () => {
    expect(isoToMinutes("2026-10-19T07:00:30.000Z", "floor")).toBe(minutes("2026-10-19T07:00:00.000Z"));
    expect(isoToMinutes("2026-10-19T07:00:30.000Z", "ceil")).toBe(minutes("2026-10-19T07:01:00.000Z"));
  });

  it("builds a full work day on DST transition days", () => {
    // Santiago starts DST on Sunday 2026-09-06 (00:00 → 01:00); the work day keeps its 9 wall-clock hours.
    const chile = computeDailyCapacity(demoInput({
      now: "2026-09-05T12:00:00.000Z",
      horizonStart: "2026-09-05T12:00:00.000Z",
      horizonEnd: "2026-09-08T12:00:00.000Z",
      preferences: { ...demoInput().preferences, timezone: "America/Santiago", workDays: [0, 1], contingencyPct: 0 },
    }));
    expect(chile).toEqual([
      { date: "2026-09-06", capacityMinutes: 540 },
      { date: "2026-09-07", capacityMinutes: 540 },
    ]);
    // Madrid falls back on Sunday 2026-10-25; Sunday 09:00–18:00 CET = 08:00Z–17:00Z.
    const madrid = computeDailyCapacity(demoInput({
      now: "2026-10-24T00:00:00.000Z",
      horizonStart: "2026-10-24T00:00:00.000Z",
      horizonEnd: "2026-10-26T00:00:00.000Z",
      preferences: { ...demoInput().preferences, workDays: [0], contingencyPct: 10 },
    }));
    expect(madrid).toEqual([{ date: "2026-10-25", capacityMinutes: 486 }]);
  });
});
