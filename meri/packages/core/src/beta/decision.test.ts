import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decide,
  INDICATORS,
  THRESHOLDS,
  verdictFor,
  type DecisionInput,
  type IndicatorKey,
} from "./decision";

const all = (hits: number, n: number): DecisionInput["indicators"] => ({
  retention60: { hits, n },
  trialToPaid: { hits, n },
  confirmedUnedited: { hits, n },
  gmailKept30: { hits, n },
  seanEllisVery: { hits, n },
  grossMargin: { meanPct: n > 0 ? (hits / n) * 100 : null, n },
});

describe("beta decision panel (D-100, docs/09)", () => {
  it("applies the docs/09 thresholds at their edges", () => {
    expect(verdictFor(45, 20, "retention60", 10)).toBe("advance");
    expect(verdictFor(44.9, 20, "retention60", 10)).toBe("iterate");
    expect(verdictFor(25, 20, "retention60", 10)).toBe("iterate");
    expect(verdictFor(24.9, 20, "retention60", 10)).toBe("pivot");
    expect(verdictFor(70, 20, "grossMargin", 10)).toBe("advance");
    expect(verdictFor(54, 20, "grossMargin", 10)).toBe("pivot");
  });

  it("below the minimum sample there is no verdict, and no data means no recommendation", () => {
    expect(verdictFor(90, 9, "trialToPaid", 10)).toBe("no_data");
    expect(decide({ indicators: all(0, 0) }).recommendation).toBe("no_data");
    expect(decide({ indicators: all(5, 9) }).indicators.every((i) => i.verdict === "no_data")).toBe(true);
  });

  it("recommends the worst verdict among the indicators with data", () => {
    const indicators = { ...all(18, 20) }; // 90 %: advance everywhere
    expect(decide({ indicators }).recommendation).toBe("advance");
    const oneWeak = { ...indicators, gmailKept30: { hits: 13, n: 20 } }; // 65 %: iterate
    expect(decide({ indicators: oneWeak }).recommendation).toBe("iterate");
    const oneBad = { ...oneWeak, seanEllisVery: { hits: 2, n: 20 } }; // 10 %: pivot
    expect(decide({ indicators: oneBad }).recommendation).toBe("pivot");
    // An indicator without enough data does not decide anything.
    expect(decide({ indicators: { ...indicators, trialToPaid: { hits: 0, n: 3 } } }).recommendation).toBe(
      "advance",
    );
  });

  it("reports the informational figures (retention 30/90, conversion by cohort) without a verdict", () => {
    const panel = decide({
      indicators: all(1, 2),
      extra: { "trialToPaid.A": { hits: 3, n: 12 }, "trialToPaid.B": { hits: 0, n: 0 } },
    });
    expect(panel.extra).toEqual([
      { key: "trialToPaid.A", valuePct: 25, n: 12 },
      { key: "trialToPaid.B", valuePct: null, n: 0 },
    ]);
  });

  it("property: the recommendation is never better than any decided indicator", () => {
    const rank = { pivot: 0, iterate: 1, advance: 2 } as const;
    const rate = fc.record({
      n: fc.integer({ min: 0, max: 200 }),
      share: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(rate, { minLength: INDICATORS.length, maxLength: INDICATORS.length }), (rates) => {
        const indicators = Object.fromEntries(
          INDICATORS.map((k, i) => {
            const r = rates[i] ?? { n: 0, share: 0 };
            return [
              k,
              k === "grossMargin"
                ? { meanPct: r.share * 100, n: r.n }
                : { hits: Math.round(r.share * r.n), n: r.n },
            ];
          }),
        ) as DecisionInput["indicators"];
        const panel = decide({ indicators });
        for (const i of panel.indicators) {
          if (i.verdict === "no_data" || panel.recommendation === "no_data") continue;
          expect(rank[panel.recommendation]).toBeLessThanOrEqual(rank[i.verdict]);
        }
        const key: IndicatorKey = "retention60";
        expect(panel.indicators.find((i) => i.key === key)?.threshold).toEqual(THRESHOLDS[key]);
      }),
      { numRuns: 300 },
    );
  });
});
