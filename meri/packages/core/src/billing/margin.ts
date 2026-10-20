/**
 * Gross margin per user and period (docs/08 "Control de coste", D-062): revenue − AI − infrastructure − Stripe.
 * Amounts in micro-USD (integers) so sums never drift.
 */
export const MARGIN_ALARM_PCT = 70;
/** Stripe card pricing used for the estimate (configuration once a real contract exists). */
export const STRIPE_FEE = { pct: 2.9, fixedMicroUsd: 300_000 } as const;

export interface MarginInput {
  revenueMicroUsd: number;
  aiCostMicroUsd: number;
  infraCostMicroUsd: number;
  /** Whether a charge happened in the period (the fixed Stripe fee applies per charge). */
  charged: boolean;
}

export interface MarginResult {
  revenueMicroUsd: number;
  costMicroUsd: number;
  stripeFeeMicroUsd: number;
  grossMarginMicroUsd: number;
  /** null without revenue (trial): a margin percentage of nothing is meaningless. */
  grossMarginPct: number | null;
  alarm: boolean;
}

export function grossMargin(input: MarginInput): MarginResult {
  const revenue = Math.max(0, Math.round(input.revenueMicroUsd));
  const stripeFee = input.charged && revenue > 0 ? Math.round((revenue * STRIPE_FEE.pct) / 100) + STRIPE_FEE.fixedMicroUsd : 0;
  const cost = Math.max(0, Math.round(input.aiCostMicroUsd)) + Math.max(0, Math.round(input.infraCostMicroUsd)) + stripeFee;
  const gross = revenue - cost;
  const pct = revenue > 0 ? Math.round((gross / revenue) * 1000) / 10 : null;
  return {
    revenueMicroUsd: revenue,
    costMicroUsd: cost,
    stripeFeeMicroUsd: stripeFee,
    grossMarginMicroUsd: gross,
    grossMarginPct: pct,
    // Trials have no revenue: their cost is reported, but the margin alarm is about paying users only.
    alarm: pct !== null && pct < MARGIN_ALARM_PCT,
  };
}

/** Monthly revenue attributed to a period from the plan price (yearly plans are spread evenly). */
export function periodRevenueMicroUsd(priceCentsPerMonth: number): number {
  return Math.max(0, priceCentsPerMonth) * 10_000;
}
