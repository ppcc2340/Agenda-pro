/**
 * Plan catalogue (docs/08, D-058): the single place where plan contents and the displayed prices live. Prices are
 * hypotheses validated in the beta; Stripe price ids are configuration, never code.
 */
export const PLAN_CODES = ["trial", "pro", "pro_plus"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export type PaidPlan = Exclude<PlanCode, "trial">;
export type BillingInterval = "month" | "year";

export const PLAN_FEATURES = ["briefings_unlimited", "advanced_exports"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface PlanDefinition {
  code: PlanCode;
  /** Displayed monthly price in US cents; the yearly figure is the per-month price when billed yearly. */
  priceCents: { month: number; year: number };
  aiCreditsMonthly: number;
  maxClients: number;
  retentionDays: number;
  features: readonly PlanFeature[];
  /** AI briefings per month when `briefings_unlimited` is not included. */
  briefingsMonthly: number | null;
}

export const PLANS: Readonly<Record<PlanCode, PlanDefinition>> = {
  // docs/08: the trial is "everything in Pro with limited credits".
  trial: {
    code: "trial",
    priceCents: { month: 0, year: 0 },
    aiCreditsMonthly: 300,
    maxClients: 25,
    retentionDays: 90,
    features: [],
    briefingsMonthly: 20,
  },
  pro: {
    code: "pro",
    priceCents: { month: 2900, year: 2400 },
    aiCreditsMonthly: 1500,
    maxClients: 25,
    retentionDays: 90,
    features: [],
    briefingsMonthly: 20,
  },
  pro_plus: {
    code: "pro_plus",
    priceCents: { month: 4900, year: 4100 },
    aiCreditsMonthly: 5000,
    maxClients: 100,
    retentionDays: 365,
    features: ["briefings_unlimited", "advanced_exports"],
    briefingsMonthly: null,
  },
};

export const isPlanCode = (value: string): value is PlanCode => (PLAN_CODES as readonly string[]).includes(value);

/** Rows written to `entitlements` when the plan changes (webhooks are the only writer besides the bootstrap). */
export interface EntitlementRow {
  maxClients: number;
  aiCreditsMonthly: number;
  retentionDays: number;
  features: PlanFeature[];
}

export function entitlementsFor(plan: PlanCode): EntitlementRow {
  const p = PLANS[plan];
  return {
    maxClients: p.maxClients,
    aiCreditsMonthly: p.aiCreditsMonthly,
    retentionDays: p.retentionDays,
    features: [...p.features],
  };
}

/** The plan that includes a feature, for the 402 answer ("upgrade to …"). */
export function planWithFeature(feature: PlanFeature): PaidPlan {
  return PLANS.pro.features.includes(feature) ? "pro" : "pro_plus";
}

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete";

export interface SubscriptionState {
  plan: PlanCode;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
}

export type AccessReason = "trial" | "trial_card_on_file" | "active" | "past_due" | "trial_ended" | "canceled" | "unpaid";

export interface Access {
  /** False pauses AI and new clients; the planner, calendar, data and export always keep working. */
  active: boolean;
  reason: AccessReason;
  /** Days left in the trial (rounded up), or null outside a trial. */
  trialDaysLeft: number | null;
}

const DAY_MS = 86_400_000;

/** D-058: effective access from the local subscription state at `now` (pure; the API computes it per request). */
export function accessFor(sub: SubscriptionState, now: Date): Access {
  const daysLeft = (end: Date | null) =>
    end === null ? null : Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
  switch (sub.status) {
    case "trialing": {
      const ended = sub.trialEndsAt !== null && sub.trialEndsAt.getTime() <= now.getTime();
      // With a card on file Stripe turns the subscription active at the end of the trial; until the webhook
      // arrives the access stays on, so a slow webhook never locks a paying user out.
      if (ended && !sub.hasPaymentMethod) return { active: false, reason: "trial_ended", trialDaysLeft: 0 };
      return {
        active: true,
        reason: sub.hasPaymentMethod ? "trial_card_on_file" : "trial",
        trialDaysLeft: daysLeft(sub.trialEndsAt),
      };
    }
    case "active":
      return { active: true, reason: "active", trialDaysLeft: null };
    case "past_due":
      return { active: true, reason: "past_due", trialDaysLeft: null };
    case "canceled":
      return { active: false, reason: "canceled", trialDaysLeft: null };
    case "unpaid":
    case "incomplete":
      return { active: false, reason: "unpaid", trialDaysLeft: null };
  }
}
