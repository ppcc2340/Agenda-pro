import { PLANS, type BillingInterval, type PaidPlan } from "./plans";

/**
 * Price experiment (D-102): two price anchors, A (the published catalogue) and B (higher, a hypothesis to confirm
 * before turning the experiment on). A workspace's cohort is deterministic and, once stored on its subscription,
 * never changes, so nobody sees the price move during a trial.
 */
export type PriceCohort = "A" | "B";
export const PRICE_EXPERIMENT = "price_anchor_v1";

export type CohortPrices = Record<PaidPlan, Record<BillingInterval, number>>;

/** Anchor B in US cents per month (the yearly figure is per month when billed yearly). Hypothesis, D-102. */
export const DEFAULT_ANCHOR_B: CohortPrices = {
  pro: { month: 3900, year: 3200 },
  pro_plus: { month: 5900, year: 4900 },
};

/** FNV-1a 32-bit: deterministic, dependency-free and good enough to split workspaces evenly. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The cohort a workspace falls into for an experiment (same input, same answer, everywhere). */
export function priceCohortOf(workspaceId: string, experiment: string = PRICE_EXPERIMENT): PriceCohort {
  return fnv1a(`${experiment}:${workspaceId}`) % 2 === 0 ? "A" : "B";
}

/**
 * The cohort to use now: a stored cohort always wins (it never changes); otherwise B is only possible while the
 * experiment is on. `assign` says whether the caller must store the result.
 */
export function resolvePriceCohort(input: {
  workspaceId: string;
  stored: PriceCohort | null;
  experimentOn: boolean;
}): { cohort: PriceCohort; assign: boolean } {
  if (input.stored) return { cohort: input.stored, assign: false };
  if (!input.experimentOn) return { cohort: "A", assign: false };
  return { cohort: priceCohortOf(input.workspaceId), assign: true };
}

/** Displayed prices of a cohort, in US cents. Anchor B can be configured (monthly cents) without code changes. */
export function cohortPrices(
  cohort: PriceCohort,
  anchorB: Partial<Record<PaidPlan, number>> = {},
): CohortPrices {
  if (cohort === "A")
    return {
      pro: { ...PLANS.pro.priceCents },
      pro_plus: { ...PLANS.pro_plus.priceCents },
    };
  const plan = (code: PaidPlan) => {
    const month = anchorB[code] ?? DEFAULT_ANCHOR_B[code].month;
    // Same yearly discount as the default anchor (about 17 %), rounded to whole dollars.
    const year = anchorB[code] ? Math.round((month * 0.83) / 100) * 100 : DEFAULT_ANCHOR_B[code].year;
    return { month, year };
  };
  return { pro: plan("pro"), pro_plus: plan("pro_plus") };
}
