import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PLANS } from "./plans";
import { cohortPrices, DEFAULT_ANCHOR_B, priceCohortOf, resolvePriceCohort } from "./cohorts";

describe("price experiment cohorts (D-102)", () => {
  it("assigns a workspace deterministically and splits workspaces about evenly", () => {
    const ids = Array.from(
      { length: 2000 },
      (_, i) => `0192aaaa-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const id of ids.slice(0, 50)) expect(priceCohortOf(id)).toBe(priceCohortOf(id));
    const b = ids.filter((id) => priceCohortOf(id) === "B").length;
    expect(b / ids.length).toBeGreaterThan(0.45);
    expect(b / ids.length).toBeLessThan(0.55);
    // Another experiment reshuffles.
    expect(ids.some((id) => priceCohortOf(id, "other") !== priceCohortOf(id))).toBe(true);
  });

  it("property: a stored cohort never changes, and B only appears while the experiment is on", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.constantFrom<"A" | "B" | null>("A", "B", null),
        fc.boolean(),
        (id, stored, on) => {
          const r = resolvePriceCohort({ workspaceId: id, stored, experimentOn: on });
          if (stored) expect(r).toEqual({ cohort: stored, assign: false });
          else if (!on) expect(r).toEqual({ cohort: "A", assign: false });
          else expect(r).toEqual({ cohort: priceCohortOf(id), assign: true });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("cohort A is the published catalogue; B uses the configured monthly anchors", () => {
    expect(cohortPrices("A")).toEqual({ pro: PLANS.pro.priceCents, pro_plus: PLANS.pro_plus.priceCents });
    expect(cohortPrices("B")).toEqual(DEFAULT_ANCHOR_B);
    expect(cohortPrices("B", { pro: 4500 })).toEqual({
      pro: { month: 4500, year: 3700 },
      pro_plus: DEFAULT_ANCHOR_B.pro_plus,
    });
    for (const plan of ["pro", "pro_plus"] as const) {
      const b = cohortPrices("B")[plan];
      expect(b.month).toBeGreaterThan(PLANS[plan].priceCents.month);
      expect(b.year).toBeLessThan(b.month);
    }
  });
});
