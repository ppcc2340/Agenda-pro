import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { csvCell } from "./csv";
import { isoWeekKey, isoWeekRange } from "./infer";

/**
 * P5-06: parsers fed by user input (`?week=` keys) and by untrusted calendar/mail text (CSV cells in the time export
 * and the ZIP export). They may only return a valid value or null, and a cell can never become a spreadsheet formula.
 */
const zones = fc.constantFrom(
  "UTC",
  "Europe/Madrid",
  "America/New_York",
  "America/Sao_Paulo",
  "Asia/Kolkata",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
);
const instant = fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2090, 0, 1) });
const HOUR = 3_600_000;

describe("isoWeekRange / isoWeekKey properties", () => {
  it("returns null or a well-formed week for any string", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 20 }), fc.stringMatching(/^\d{4}-W\d{2}$/)),
        zones,
        (key, tz) => {
          const r = isoWeekRange(key, tz);
          if (r === null) return;
          expect(r.days).toHaveLength(7);
          expect(new Set(r.days).size).toBe(7);
          const span = r.to.getTime() - r.from.getTime();
          // Seven local days, give or take one DST shift (Lord Howe shifts by 30 minutes).
          expect(span).toBeGreaterThanOrEqual(7 * 24 * HOUR - HOUR);
          expect(span).toBeLessThanOrEqual(7 * 24 * HOUR + HOUR);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("the week of an instant contains that instant (round trip)", () => {
    fc.assert(
      fc.property(instant, zones, (t, tz) => {
        const key = isoWeekKey(t, tz);
        const r = isoWeekRange(key, tz);
        expect(r).not.toBeNull();
        expect(r?.from.getTime()).toBeLessThanOrEqual(t);
        expect(r?.to.getTime()).toBeGreaterThan(t);
      }),
      { numRuns: 400 },
    );
  });
});

describe("csvCell properties", () => {
  const hostile = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.string({
      unit: fc.constantFrom("=", "+", "-", "@", "\t", "\r", "\n", '"', ",", ";", "a", " ", "1"),
      maxLength: 20,
    }),
  );

  it("always yields one quoted field with no raw newline and no formula trigger", () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const cell = csvCell(value);
        expect(cell.startsWith('"') && cell.endsWith('"')).toBe(true);
        const inner = cell.slice(1, -1);
        // Every quote inside is doubled, so a parser sees exactly one field.
        expect(inner.replace(/""/g, "")).not.toContain('"');
        expect(inner).not.toContain("\n");
        expect(inner).not.toMatch(/^[=+\-@\t\r]/);
        // Nothing but the guard apostrophe, quote doubling and newline folding changes the text.
        const unescaped = inner.replace(/""/g, '"');
        const expected = value.replace(/\r?\n/g, " ");
        expect([expected, `'${expected}`]).toContain(unescaped);
      }),
      { numRuns: 500 },
    );
  });
});
