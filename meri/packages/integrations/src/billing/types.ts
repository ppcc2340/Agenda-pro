import type { HealthReport } from "../errors";

export type PlanCode = "trial" | "pro" | "pro_plus";

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface SubscriptionSnapshot {
  customerId: string;
  subscriptionId: string;
  plan: PlanCode;
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export interface BillingWebhookEvent {
  id: string;
  type: string;
  data: unknown;
}

/** Billing connector (docs/08). Live implementation = Stripe; fake keeps everything local and never charges. */
export interface BillingProvider {
  readonly mode: "fake" | "live";
  healthCheck(): Promise<HealthReport>;
  createCheckoutSession(input: {
    workspaceId: string;
    email: string;
    plan: Exclude<PlanCode, "trial">;
    interval: "month" | "year";
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  /** Verifies the signature and parses the event; throws IntegrationError(Permanent) on a bad signature. */
  parseWebhook(rawBody: string, signature: string): Promise<BillingWebhookEvent>;
}
