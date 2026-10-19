import { IntegrationError, type HealthReport } from "../errors";
import type {
  BillingProvider,
  BillingWebhookEvent,
  CheckoutSession,
  PlanCode,
  SubscriptionSnapshot,
} from "../billing/types";

/** Local billing stand-in: never charges, keeps subscriptions in memory, "signs" webhooks with a shared string. */
export class FakeBilling implements BillingProvider {
  readonly mode = "fake" as const;
  readonly subscriptions = new Map<string, SubscriptionSnapshot>();
  private counter = 0;
  constructor(
    private readonly now: () => Date,
    private readonly webhookSecret = "fake-webhook-secret",
  ) {}

  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({ provider: "stripe", mode: "fake", status: "healthy", detail: "FakeBilling" });
  }

  createCheckoutSession(input: {
    workspaceId: string;
    email: string;
    plan: Exclude<PlanCode, "trial">;
    interval: "month" | "year";
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    const id = `fake-cs-${String(++this.counter)}`;
    const subscriptionId = `fake-sub-${String(this.counter)}`;
    const periodDays = input.interval === "year" ? 365 : 30;
    this.subscriptions.set(subscriptionId, {
      customerId: `fake-cus-${input.workspaceId.slice(0, 8)}`,
      subscriptionId,
      plan: input.plan,
      status: "trialing",
      currentPeriodEnd: new Date(this.now().getTime() + periodDays * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    return Promise.resolve({
      id,
      url: `${input.successUrl}?fake_checkout=${id}&subscription=${subscriptionId}`,
    });
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return Promise.resolve({ url: `${input.returnUrl}?fake_portal=${input.customerId}` });
  }

  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    return Promise.resolve(this.subscriptions.get(subscriptionId) ?? null);
  }

  parseWebhook(rawBody: string, signature: string): Promise<BillingWebhookEvent> {
    if (signature !== this.webhookSecret) {
      return Promise.reject(new IntegrationError("Permanent", "stripe", "invalid webhook signature"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (cause) {
      return Promise.reject(
        new IntegrationError("Permanent", "stripe", "malformed webhook event", { cause }),
      );
    }
    if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || !("type" in parsed)) {
      return Promise.reject(new IntegrationError("Permanent", "stripe", "malformed webhook event"));
    }
    const ev = parsed as { id: string; type: string; data?: unknown };
    return Promise.resolve({ id: ev.id, type: ev.type, data: ev.data ?? null });
  }
}
