import { describe, expect, it } from "vitest";
import { addLocalDays, fromLocalParts, localDateKey, parseHHMM, toLocalParts } from "./local";

describe("local time helpers", () => {
  it("converts between UTC instants and local wall-clock across DST", () => {
    const tz = "Europe/Madrid";
    const before = Date.UTC(2026, 9, 24, 10, 0); // CEST (+2)
    expect(toLocalParts(before, tz)).toMatchObject({ hour: 12, weekday: 6, day: 24 });
    const after = Date.UTC(2026, 9, 26, 10, 0); // CET (+1)
    expect(toLocalParts(after, tz)).toMatchObject({ hour: 11, weekday: 1 });
    expect(fromLocalParts({ year: 2026, month: 10, day: 26, hour: 9, minute: 0 }, tz)).toBe(
      Date.UTC(2026, 9, 26, 8, 0),
    );
    expect(fromLocalParts({ year: 2026, month: 10, day: 24, hour: 9, minute: 0 }, tz)).toBe(
      Date.UTC(2026, 9, 24, 7, 0),
    );
    expect(localDateKey(Date.UTC(2026, 9, 19, 2, 30), "America/Santiago")).toBe("2026-10-18");
    expect(parseHHMM("09:30")).toBe(570);
    expect(addLocalDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
  });
});
