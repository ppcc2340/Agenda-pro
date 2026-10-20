import type { HealthReport } from "../errors";

export type PlanCode = "trial" | "pro" | "pro_plus";
export type PaidPlanCode = Exclude<PlanCode, "trial">;
export type BillingInterval = "month" | "year";
export type CreditPackCode = "500" | "2000";
export type ProviderSubscriptionStatus =
  "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete";

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Canonical subscription read from the provider (never trusted from a webhook body, ADR 0006 §3). */
export interface SubscriptionSnapshot {
  customerId: string;
  subscriptionId: string;
  plan: PaidPlanCode;
  interval: BillingInterval;
  status: ProviderSubscriptionStatus;
  trialEnd: string | null;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
  /** From the subscription's own metadata, set by Meri when the checkout session was created. */
  workspaceId: string | null;
}

export type BillingEventType =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted"
  | "invoice.paid"
  | "invoice.payment_failed";

/** Webhook normalised by the adapter: Meri never reads raw provider objects outside the adapter. */
export interface BillingWebhookEvent {
  id: string;
  type: BillingEventType | "other";
  createdAt: string;
  /** From metadata / client_reference_id (checkout); resolved from the canonical subscription otherwise. */
  workspaceId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  checkout: { mode: "subscription" | "payment"; sessionId: string; creditPack: CreditPackCode | null } | null;
  invoice: { amountPaidCents: number } | null;
}

/** Canonical checkout session read back from the provider (credit packs are granted only from this, [M1]). */
export interface CheckoutSnapshot {
  id: string;
  mode: "subscription" | "payment";
  /** Only `paid` grants a pack; asynchronous methods report `unpaid` until the money arrives. */
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  workspaceId: string | null;
  customerId: string | null;
  creditPack: CreditPackCode | null;
}

export interface CheckoutInput {
  workspaceId: string;
  email: string;
  /** Existing provider customer, if any (reuse instead of creating a second one). */
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

/** Billing connector (docs/08, ADR 0006). Live = Stripe; fake keeps everything local and never charges. */
export interface BillingProvider {
  readonly mode: "fake" | "live";
  healthCheck(): Promise<HealthReport>;
  createCheckoutSession(
    input: CheckoutInput & { plan: PaidPlanCode; interval: BillingInterval; trialEnd: string | null },
  ): Promise<CheckoutSession>;
  createCreditPackCheckout(input: CheckoutInput & { pack: CreditPackCode }): Promise<CheckoutSession>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** The workspace's provider customer, created once (idempotent per workspace) so every checkout shares it. */
  ensureCustomer(input: { workspaceId: string; email: string; customerId: string | null }): Promise<string>;
  getCheckoutSession(sessionId: string): Promise<CheckoutSnapshot | null>;
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  /**
   * `atPeriodEnd: false` cancels now (account deletion, duplicates). `idempotencyKey` must be unique per user
   * intent: a reused key replays an old provider response and changes nothing (security review H1).
   */
  cancelSubscription(
    subscriptionId: string,
    options: { atPeriodEnd: boolean; idempotencyKey: string },
  ): Promise<SubscriptionSnapshot>;
  resumeSubscription(
    subscriptionId: string,
    options: { idempotencyKey: string },
  ): Promise<SubscriptionSnapshot>;
  /**
   * Erasure (F-16, ADR 0007): deletes the provider customer of a purged workspace. Idempotent: a customer that no
   * longer exists counts as deleted. Invoices stay at the provider as its legal record.
   */
  deleteCustomer(customerId: string): Promise<void>;
  /** Verifies the `t=…,v1=` signature over the raw body; throws IntegrationError(Permanent) when it fails. */
  parseWebhook(rawBody: string, signatureHeader: string): Promise<BillingWebhookEvent>;
}
