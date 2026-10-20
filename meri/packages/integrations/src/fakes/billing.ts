import { randomUUID } from "node:crypto";
import { IntegrationError, type HealthReport } from "../errors";
import { signWebhook, verifyWebhookSignature } from "../billing/signature";
import { normalizeStripeEvent, parseStripeJson } from "../billing/stripe-events";
import type {
  BillingInterval,
  BillingProvider,
  BillingWebhookEvent,
  CheckoutInput,
  CheckoutSession,
  CheckoutSnapshot,
  CreditPackCode,
  PaidPlanCode,
  SubscriptionSnapshot,
} from "../billing/types";

interface FakeSession {
  id: string;
  workspaceId: string;
  customerId: string;
  mode: "subscription" | "payment";
  plan: PaidPlanCode | null;
  interval: BillingInterval | null;
  pack: CreditPackCode | null;
  trialEnd: string | null;
  completed: boolean;
  /** Test driver: an asynchronous payment method leaves a completed session `unpaid`. */
  paymentStatus?: "paid" | "unpaid";
  subscriptionId?: string | null;
}

/** A webhook ready to post: the raw body and its `Stripe-Signature` header. */
export interface SignedWebhook {
  rawBody: string;
  signature: string;
}

export type FakeLifecycleStep = "invoice_paid" | "payment_failed" | "updated" | "deleted";

const PERIOD_DAYS: Record<BillingInterval, number> = { month: 30, year: 365 };
const PRICE_CENTS: Record<PaidPlanCode, Record<BillingInterval, number>> = {
  pro: { month: 2900, year: 28800 },
  pro_plus: { month: 4900, year: 49200 },
};

/**
 * Local billing stand-in (docs/blockers/stripe.md): never charges, keeps sessions and subscriptions in memory and
 * emits **Stripe-shaped** events signed with the same `t=…,v1=` HMAC scheme as Stripe, so the webhook route, the
 * signature verifier and the event mapping are the production ones. `completeCheckout` and `simulate` drive the
 * lifecycle in tests, the demo and the E2E (ADR 0006).
 */
export class FakeBilling implements BillingProvider {
  readonly mode = "fake" as const;
  readonly subscriptions = new Map<string, SubscriptionSnapshot>();
  readonly sessions = new Map<string, FakeSession>();
  /** Idempotency keys received by cancellations (tests assert they are unique per intent). */
  readonly cancelKeys: string[] = [];
  private counter = 0;

  constructor(
    private readonly now: () => Date,
    private readonly options: { webhookSecret?: string; completeUrl?: string } = {},
  ) {}

  get webhookSecret(): string {
    return this.options.webhookSecret ?? "whsec_fake_meri";
  }

  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({ provider: "stripe", mode: "fake", status: "healthy", detail: "FakeBilling" });
  }

  /** Per-instance salt: ids must stay unique across restarts, or a new event would look like a replay. */
  private readonly instance = randomUUID().slice(0, 8);

  private next(prefix: string): string {
    return `${prefix}_fake_${this.instance}_${String(++this.counter)}`;
  }

  private session(
    input: CheckoutInput,
    extra: Pick<FakeSession, "mode" | "plan" | "interval" | "pack" | "trialEnd">,
  ): CheckoutSession {
    const id = this.next("cs");
    this.sessions.set(id, {
      id,
      workspaceId: input.workspaceId,
      customerId: input.customerId ?? `cus_fake_${input.workspaceId.slice(0, 8)}`,
      completed: false,
      ...extra,
    });
    const base = this.options.completeUrl ?? input.successUrl;
    return { id, url: `${base}${base.includes("?") ? "&" : "?"}session=${id}` };
  }

  createCheckoutSession(
    input: CheckoutInput & { plan: PaidPlanCode; interval: BillingInterval; trialEnd: string | null },
  ): Promise<CheckoutSession> {
    return Promise.resolve(
      this.session(input, {
        mode: "subscription",
        plan: input.plan,
        interval: input.interval,
        pack: null,
        trialEnd: input.trialEnd,
      }),
    );
  }

  createCreditPackCheckout(input: CheckoutInput & { pack: CreditPackCode }): Promise<CheckoutSession> {
    return Promise.resolve(
      this.session(input, { mode: "payment", plan: null, interval: null, pack: input.pack, trialEnd: null }),
    );
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return Promise.resolve({
      url: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}fake_portal=${input.customerId}`,
    });
  }

  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    const s = this.subscriptions.get(subscriptionId);
    return Promise.resolve(s ? { ...s } : null);
  }

  private mustGet(subscriptionId: string): SubscriptionSnapshot {
    const s = this.subscriptions.get(subscriptionId);
    if (!s) throw new IntegrationError("Permanent", "stripe", `no such subscription: ${subscriptionId}`);
    return s;
  }

  ensureCustomer(input: { workspaceId: string; email: string; customerId: string | null }): Promise<string> {
    return Promise.resolve(input.customerId ?? `cus_fake_${input.workspaceId.slice(0, 8)}`);
  }

  /** Customers erased through `deleteCustomer` (tests assert on it). */
  readonly deletedCustomers: string[] = [];

  deleteCustomer(customerId: string): Promise<void> {
    if (!this.deletedCustomers.includes(customerId)) this.deletedCustomers.push(customerId);
    return Promise.resolve();
  }

  getCheckoutSession(sessionId: string): Promise<CheckoutSnapshot | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.resolve(null);
    return Promise.resolve({
      id: s.id,
      mode: s.mode,
      paymentStatus: s.completed ? (s.paymentStatus ?? "paid") : "unpaid",
      workspaceId: s.workspaceId,
      customerId: s.customerId,
      creditPack: s.pack,
    });
  }

  cancelSubscription(
    subscriptionId: string,
    options: { atPeriodEnd: boolean; idempotencyKey: string },
  ): Promise<SubscriptionSnapshot> {
    this.cancelKeys.push(options.idempotencyKey);
    const s = this.mustGet(subscriptionId);
    const updated: SubscriptionSnapshot = options.atPeriodEnd
      ? { ...s, cancelAtPeriodEnd: true }
      : { ...s, status: "canceled", cancelAtPeriodEnd: false };
    this.subscriptions.set(subscriptionId, updated);
    return Promise.resolve({ ...updated });
  }

  resumeSubscription(
    subscriptionId: string,
    _options: { idempotencyKey: string },
  ): Promise<SubscriptionSnapshot> {
    const s = this.mustGet(subscriptionId);
    if (s.status === "canceled")
      return Promise.reject(new IntegrationError("Permanent", "stripe", "subscription already ended"));
    const updated = { ...s, cancelAtPeriodEnd: false };
    this.subscriptions.set(subscriptionId, updated);
    return Promise.resolve({ ...updated });
  }

  parseWebhook(rawBody: string, signatureHeader: string): Promise<BillingWebhookEvent> {
    try {
      verifyWebhookSignature({
        secret: this.webhookSecret,
        rawBody,
        header: signatureHeader,
        nowSeconds: Math.floor(this.now().getTime() / 1000),
      });
      return Promise.resolve(normalizeStripeEvent(parseStripeJson(rawBody)));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---------- Test, demo and E2E drivers (not part of BillingProvider) ----------

  /** Signs a Stripe-shaped event with this fake's secret (also used by tests to forge bad or stale ones). */
  sign(
    type: string,
    object: Record<string, unknown>,
    options: { secret?: string; atSeconds?: number } = {},
  ): SignedWebhook {
    const createdSeconds = options.atSeconds ?? Math.floor(this.now().getTime() / 1000);
    const rawBody = JSON.stringify({
      id: this.next("evt"),
      object: "event",
      type,
      created: createdSeconds,
      data: { object },
    });
    return { rawBody, signature: signWebhook(options.secret ?? this.webhookSecret, rawBody, createdSeconds) };
  }

  /** The customer pays (or adds a card) in the hosted checkout: creates the subscription and returns the event. */
  completeCheckout(sessionId: string, options: { paymentStatus?: "paid" | "unpaid" } = {}): SignedWebhook {
    const s = this.sessions.get(sessionId);
    if (!s) throw new IntegrationError("Permanent", "stripe", `no such checkout session: ${sessionId}`);
    let subscriptionId: string | null = null;
    if (s.mode === "subscription" && s.plan && s.interval) {
      subscriptionId = this.next("sub");
      const now = this.now();
      const inTrial = s.trialEnd !== null && new Date(s.trialEnd).getTime() > now.getTime();
      this.subscriptions.set(subscriptionId, {
        customerId: s.customerId,
        subscriptionId,
        plan: s.plan,
        interval: s.interval,
        status: inTrial ? "trialing" : "active",
        trialEnd: inTrial ? s.trialEnd : null,
        currentPeriodEnd:
          inTrial && s.trialEnd
            ? s.trialEnd
            : new Date(now.getTime() + PERIOD_DAYS[s.interval] * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
        hasPaymentMethod: true,
        workspaceId: s.workspaceId,
      });
    }
    s.completed = true;
    s.paymentStatus = options.paymentStatus ?? "paid";
    s.subscriptionId = subscriptionId;
    return this.signCheckout(s, "checkout.session.completed");
  }

  /** An asynchronous payment (bank debit, voucher) of a completed session finally arrives. */
  settleAsyncPayment(sessionId: string): SignedWebhook {
    const s = this.sessions.get(sessionId);
    if (!s?.completed)
      throw new IntegrationError("Permanent", "stripe", `no completed checkout session: ${sessionId}`);
    s.paymentStatus = "paid";
    return this.signCheckout(s, "checkout.session.async_payment_succeeded");
  }

  /** Re-sends a session's `checkout.session.completed` with its current state (a provider retry or replay). */
  resendCheckout(sessionId: string): SignedWebhook {
    const s = this.sessions.get(sessionId);
    if (!s?.completed)
      throw new IntegrationError("Permanent", "stripe", `no completed checkout session: ${sessionId}`);
    return this.signCheckout(s, "checkout.session.completed");
  }

  private signCheckout(s: FakeSession, type: string): SignedWebhook {
    return this.sign(type, {
      id: s.id,
      object: "checkout.session",
      mode: s.mode,
      payment_status: s.paymentStatus ?? "unpaid",
      client_reference_id: s.workspaceId,
      customer: s.customerId,
      subscription: s.subscriptionId ?? null,
      metadata: { workspaceId: s.workspaceId, ...(s.pack ? { creditPack: s.pack } : {}) },
    });
  }

  /** Moves a subscription through its lifecycle and returns the matching event (renewal, failure, deletion…). */
  simulate(step: FakeLifecycleStep, subscriptionId: string): SignedWebhook {
    const s = this.mustGet(subscriptionId);
    const now = this.now();
    const subscriptionObject = (snap: SubscriptionSnapshot) => ({
      id: snap.subscriptionId,
      object: "subscription",
      customer: snap.customerId,
      metadata: snap.workspaceId ? { workspaceId: snap.workspaceId } : {},
    });
    if (step === "invoice_paid") {
      const end = new Date(
        Math.max(now.getTime(), new Date(s.currentPeriodEnd).getTime()) +
          PERIOD_DAYS[s.interval] * 86_400_000,
      );
      const updated: SubscriptionSnapshot = {
        ...s,
        status: "active",
        trialEnd: null,
        currentPeriodEnd: end.toISOString(),
      };
      this.subscriptions.set(subscriptionId, updated);
      return this.sign("invoice.paid", {
        id: this.next("in"),
        object: "invoice",
        customer: s.customerId,
        subscription: s.subscriptionId,
        amount_paid: PRICE_CENTS[s.plan][s.interval],
      });
    }
    if (step === "payment_failed") {
      this.subscriptions.set(subscriptionId, { ...s, status: "past_due" });
      return this.sign("invoice.payment_failed", {
        id: this.next("in"),
        object: "invoice",
        customer: s.customerId,
        subscription: s.subscriptionId,
        amount_paid: 0,
      });
    }
    if (step === "deleted") {
      const ended: SubscriptionSnapshot = { ...s, status: "canceled", cancelAtPeriodEnd: false };
      this.subscriptions.set(subscriptionId, ended);
      return this.sign("customer.subscription.deleted", subscriptionObject(ended));
    }
    return this.sign("customer.subscription.updated", subscriptionObject(s));
  }
}
