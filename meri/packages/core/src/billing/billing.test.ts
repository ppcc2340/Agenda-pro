import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AI_OPERATIONS,
  CREDIT_COSTS,
  CREDIT_PACKS,
  CREDIT_PACK_PRICE_CENTS,
  chargeDecision,
  creditBalance,
  creditOperationOf,
  crossedThresholds,
  roundCredits,
} from "./credits";
import { grossMargin, periodRevenueMicroUsd } from "./margin";
import { PLANS, accessFor, entitlementsFor, isPlanCode, planWithFeature, type SubscriptionState } from "./plans";

const NOW = new Date("2026-10-20T08:40:00Z");
const base: SubscriptionState = {
  plan: "trial",
  status: "trialing",
  trialEndsAt: new Date("2026-10-29T08:40:00Z"),
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  hasPaymentMethod: false,
};

describe("plan catalogue (D-058)", () => {
  it("maps every plan to its entitlements and Pro+ is the one with unlimited briefings", () => {
    expect(entitlementsFor("pro")).toEqual({ maxClients: 25, aiCreditsMonthly: 1500, retentionDays: 90, features: [] });
    expect(entitlementsFor("pro_plus").features).toEqual(["briefings_unlimited", "advanced_exports"]);
    // The trial is Pro with fewer credits (docs/08).
    expect(entitlementsFor("trial")).toEqual({ ...entitlementsFor("pro"), aiCreditsMonthly: 300 });
    expect(planWithFeature("briefings_unlimited")).toBe("pro_plus");
    expect(PLANS.pro.priceCents).toEqual({ month: 2900, year: 2400 });
    expect(isPlanCode("pro")).toBe(true);
    expect(isPlanCode("enterprise")).toBe(false);
  });

  it("access: a running trial is active, an ended trial without card is not, with a card it stays on", () => {
    expect(accessFor(base, NOW)).toEqual({ active: true, reason: "trial", trialDaysLeft: 9 });
    const ended = { ...base, trialEndsAt: new Date("2026-10-19T08:40:00Z") };
    expect(accessFor(ended, NOW)).toEqual({ active: false, reason: "trial_ended", trialDaysLeft: 0 });
    expect(accessFor({ ...ended, hasPaymentMethod: true }, NOW)).toMatchObject({ active: true, reason: "trial_card_on_file" });
    expect(accessFor({ ...base, trialEndsAt: null }, NOW)).toEqual({ active: true, reason: "trial", trialDaysLeft: null });
  });

  it("access: active and past_due keep the account on; canceled, unpaid and incomplete pause it", () => {
    for (const [status, active] of [["active", true], ["past_due", true], ["canceled", false], ["unpaid", false], ["incomplete", false]] as const)
      expect(accessFor({ ...base, plan: "pro", status }, NOW).active, status).toBe(active);
  });
});

describe("credits (D-061)", () => {
  it("every pack has a display price and bigger packs cost less per credit (D-068)", () => {
    const packs = Object.keys(CREDIT_PACKS) as (keyof typeof CREDIT_PACKS)[];
    expect(Object.keys(CREDIT_PACK_PRICE_CENTS).sort()).toEqual([...packs].sort());
    const perCredit = packs.map((p) => CREDIT_PACK_PRICE_CENTS[p] / CREDIT_PACKS[p]);
    expect(perCredit[1]).toBeLessThan(perCredit[0] ?? 0);
  });
  it("costs follow docs/08 and the balance adds packs to the monthly allowance", () => {
    expect(CREDIT_COSTS).toEqual({ extract_commitments: 1, capture_parse: 0.2, followup_draft: 3, brief_client: 5, summary: 1 });
    const b = creditBalance({ monthly: 1500, granted: 500, used: 1999.8 });
    expect(b).toMatchObject({ allowance: 2000, used: 1999.8, remaining: 0.2 });
    expect(chargeDecision(b, "capture_parse")).toEqual({ kind: "allow", cost: 0.2 });
    expect(chargeDecision(b, "summary")).toEqual({ kind: "deny", cost: 1, reason: "credits_exhausted" });
    expect(chargeDecision(creditBalance({ monthly: 10, granted: 0, used: 0 }), "extract_commitments", 3)).toEqual({ kind: "allow", cost: 3 });
  });

  it("maps AI request names to the credit operation they bill", () => {
    expect(creditOperationOf("capture.parse")).toBe("capture_parse");
    expect(creditOperationOf("extract_commitments")).toBe("extract_commitments");
    expect(creditOperationOf("brief_client")).toBe("brief_client");
    expect(creditOperationOf("unknown.op")).toBeNull();
  });

  it("an allowance of zero denies everything and reports an infinite ratio once used", () => {
    expect(creditBalance({ monthly: 0, granted: 0, used: 0 }).ratio).toBe(0);
    expect(creditBalance({ monthly: 0, granted: 0, used: 1 }).ratio).toBe(Number.POSITIVE_INFINITY);
    expect(chargeDecision(creditBalance({ monthly: 0, granted: 0, used: 0 }), "capture_parse").kind).toBe("deny");
    expect(crossedThresholds(0, 0, 1)).toEqual([1]);
    expect(crossedThresholds(0, 1, 2)).toEqual([]);
  });

  it("thresholds: 80 % and 100 % fire exactly when crossed, never again in the same period", () => {
    expect(crossedThresholds(100, 79, 80)).toEqual([0.8]);
    expect(crossedThresholds(100, 70, 100)).toEqual([0.8, 1]);
    expect(crossedThresholds(100, 80, 90)).toEqual([]);
    expect(crossedThresholds(100, 99.8, 100)).toEqual([1]);
    expect(crossedThresholds(100, 100, 105)).toEqual([]);
  });

  it("properties: consuming never raises the balance and deny happens exactly when the cost does not fit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 800_000 }).map((n) => n / 100),
        fc.constantFrom(...AI_OPERATIONS),
        fc.integer({ min: 1, max: 5 }),
        (monthly, granted, used, op, units) => {
          const before = creditBalance({ monthly, granted, used });
          const decision = chargeDecision(before, op, units);
          const cost = roundCredits(CREDIT_COSTS[op] * units);
          expect(decision.kind === "allow").toBe(cost <= before.remaining + 1e-9);
          const after = creditBalance({ monthly, granted, used: used + cost });
          expect(after.remaining).toBeLessThanOrEqual(before.remaining);
          // Each threshold fires at most once along any sequence of charges.
          const crossed = crossedThresholds(before.allowance, before.used, after.used);
          expect(new Set(crossed).size).toBe(crossed.length);
          expect(crossedThresholds(before.allowance, after.used, after.used)).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("gross margin (D-062)", () => {
  it("revenue minus AI, infrastructure and Stripe; alarm below 70 %", () => {
    const pro = periodRevenueMicroUsd(PLANS.pro.priceCents.month); // US$29
    const healthy = grossMargin({ revenueMicroUsd: pro, aiCostMicroUsd: 2_000_000, infraCostMicroUsd: 3_000_000, charged: true });
    // 29 − (2 + 3 + 0.841 + 0.30) = 22.859 → 78.8 %
    expect(healthy).toMatchObject({ stripeFeeMicroUsd: 1_141_000, grossMarginMicroUsd: 22_859_000, grossMarginPct: 78.8, alarm: false });
    const tight = grossMargin({ revenueMicroUsd: pro, aiCostMicroUsd: 6_000_000, infraCostMicroUsd: 3_000_000, charged: true });
    expect(tight.alarm).toBe(true);
    expect(tight.grossMarginPct).toBe(65); // 29 − (6 + 3 + 1.141) = 18.859
  });

  it("a trial has no margin percentage and no alarm; no charge means no Stripe fee", () => {
    expect(grossMargin({ revenueMicroUsd: 0, aiCostMicroUsd: 1_000_000, infraCostMicroUsd: 3_000_000, charged: false })).toEqual({
      revenueMicroUsd: 0,
      costMicroUsd: 4_000_000,
      stripeFeeMicroUsd: 0,
      grossMarginMicroUsd: -4_000_000,
      grossMarginPct: null,
      alarm: false,
    });
    expect(grossMargin({ revenueMicroUsd: 29_000_000, aiCostMicroUsd: 0, infraCostMicroUsd: 0, charged: false }).stripeFeeMicroUsd).toBe(0);
    expect(periodRevenueMicroUsd(-5)).toBe(0);
  });
});
