import { z } from "zod";
import { IntegrationError, type HealthReport } from "../errors";
import { verifyWebhookSignature } from "./signature";
import { STRIPE_API_VERSION, normalizeStripeEvent, parseStripeJson } from "./stripe-events";
import type {
  BillingInterval,
  BillingProvider,
  BillingWebhookEvent,
  CheckoutInput,
  CheckoutSession,
  CreditPackCode,
  PaidPlanCode,
  ProviderSubscriptionStatus,
  SubscriptionSnapshot,
} from "./types";

/** Stripe price ids per plan and interval, and per credit pack (configuration: docs/blockers/stripe.md). */
export interface StripePrices {
  pro: Record<BillingInterval, string>;
  pro_plus: Record<BillingInterval, string>;
  credits: Record<CreditPackCode, string>;
}

export interface StripeBillingOptions {
  secretKey: string;
  webhookSecret: string;
  prices: StripePrices;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Wall clock for the signature tolerance (Stripe signs with real time, never with DEMO_NOW). */
  nowSeconds?: () => number;
}

type Params = Record<string, string | number | boolean | null | undefined>;

const Ref = z
  .union([z.string(), z.object({ id: z.string() })])
  .nullish()
  .transform((v) => (v === null || v === undefined ? null : typeof v === "string" ? v : v.id));
const StripeSubscription = z.object({
  id: z.string(),
  customer: Ref,
  status: z.string(),
  trial_end: z.number().nullish(),
  current_period_end: z.number().nullish(),
  cancel_at_period_end: z.boolean().default(false),
  default_payment_method: Ref,
  metadata: z.record(z.string(), z.string()).nullish(),
  items: z.object({
    data: z.array(
      z.object({
        current_period_end: z.number().nullish(),
        price: z.object({ id: z.string(), recurring: z.object({ interval: z.string() }).nullish() }),
      }),
    ),
  }),
});

const STATUS: Readonly<Record<string, ProviderSubscriptionStatus>> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "unpaid",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  paused: "unpaid",
};

const iso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();

/** Flattens nested params into Stripe's form encoding (`a[b][c]=v`). */
export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) out.append(k, String(v));
  return out.toString();
}

/**
 * Live Stripe adapter (docs/08, ADR 0006): REST over fetch, form-encoded, pinned `Stripe-Version`, an
 * `Idempotency-Key` on every write, Checkout with Stripe Tax and tax-id collection. Webhooks share the verifier and
 * the event mapping with the fake, so switching `STRIPE_MODE` needs no code.
 */
export class StripeBilling implements BillingProvider {
  readonly mode = "live" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly planOfPrice: Map<string, { plan: PaidPlanCode; interval: BillingInterval }>;

  constructor(private readonly options: StripeBillingOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.stripe.com";
    this.planOfPrice = new Map();
    for (const plan of ["pro", "pro_plus"] as const)
      for (const interval of ["month", "year"] as const)
        this.planOfPrice.set(options.prices[plan][interval], { plan, interval });
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Params = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;
    if (method === "GET") {
      const qs = formEncode(params);
      if (qs) url += `?${qs}`;
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = formEncode(params);
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (cause) {
      throw new IntegrationError("Transient", "stripe", "network error talking to Stripe", { cause });
    }
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) return json as T;
    const message =
      typeof json === "object" &&
      json &&
      "error" in json &&
      typeof json.error === "object" &&
      json.error &&
      "message" in json.error
        ? String(json.error.message)
        : `HTTP ${String(res.status)}`;
    if (res.status === 429)
      throw new IntegrationError("RateLimited", "stripe", message, {
        retryAfterMs: Number(res.headers.get("retry-after") ?? 1) * 1000,
      });
    if (res.status >= 500) throw new IntegrationError("Transient", "stripe", message);
    if (res.status === 401) throw new IntegrationError("AuthExpired", "stripe", message);
    throw new IntegrationError("Permanent", "stripe", message);
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      await this.call("GET", "/v1/balance");
      return { provider: "stripe", mode: "live", status: "healthy" };
    } catch (err) {
      return {
        provider: "stripe",
        mode: "live",
        status: "degraded",
        detail: err instanceof Error ? err.message : "error",
      };
    }
  }

  private customerParams(input: CheckoutInput): Params {
    return input.customerId
      ? { customer: input.customerId, "customer_update[address]": "auto", "customer_update[name]": "auto" }
      : { customer_email: input.email };
  }

  async createCheckoutSession(
    input: CheckoutInput & { plan: PaidPlanCode; interval: BillingInterval; trialEnd: string | null },
  ): Promise<CheckoutSession> {
    const trialEnd = input.trialEnd ? Math.floor(new Date(input.trialEnd).getTime() / 1000) : null;
    const session = await this.call<{ id: string; url: string }>(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        "line_items[0][price]": this.options.prices[input.plan][input.interval],
        "line_items[0][quantity]": 1,
        ...this.customerParams(input),
        client_reference_id: input.workspaceId,
        "metadata[workspaceId]": input.workspaceId,
        "subscription_data[metadata][workspaceId]": input.workspaceId,
        "subscription_data[trial_end]": trialEnd,
        "automatic_tax[enabled]": true,
        "tax_id_collection[enabled]": true,
        billing_address_collection: "required",
        payment_method_collection: "always",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      input.idempotencyKey,
    );
    return { id: session.id, url: session.url };
  }

  async createCreditPackCheckout(input: CheckoutInput & { pack: CreditPackCode }): Promise<CheckoutSession> {
    const session = await this.call<{ id: string; url: string }>(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "payment",
        "line_items[0][price]": this.options.prices.credits[input.pack],
        "line_items[0][quantity]": 1,
        ...this.customerParams(input),
        client_reference_id: input.workspaceId,
        "metadata[workspaceId]": input.workspaceId,
        "metadata[creditPack]": input.pack,
        "automatic_tax[enabled]": true,
        "invoice_creation[enabled]": true,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      input.idempotencyKey,
    );
    return { id: session.id, url: session.url };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const portal = await this.call<{ url: string }>("POST", "/v1/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: portal.url };
  }

  /** Maps a Stripe subscription object; throws when its price is not one of Meri's (misconfiguration). */
  toSnapshot(raw: unknown): SubscriptionSnapshot {
    const s = StripeSubscription.safeParse(raw);
    if (!s.success) throw new IntegrationError("Permanent", "stripe", "malformed subscription object");
    const item = s.data.items.data[0];
    const known = item ? this.planOfPrice.get(item.price.id) : undefined;
    if (!item || !known)
      throw new IntegrationError("Permanent", "stripe", `subscription ${s.data.id} has no known Meri price`);
    const periodEnd = item.current_period_end ?? s.data.current_period_end;
    const workspaceId = s.data.metadata?.workspaceId ?? null;
    return {
      customerId: s.data.customer ?? "",
      subscriptionId: s.data.id,
      plan: known.plan,
      interval: known.interval,
      status: STATUS[s.data.status] ?? "unpaid",
      trialEnd: iso(s.data.trial_end),
      currentPeriodEnd: iso(periodEnd) ?? new Date(0).toISOString(),
      cancelAtPeriodEnd: s.data.cancel_at_period_end,
      hasPaymentMethod: s.data.default_payment_method !== null,
      workspaceId: workspaceId && z.string().uuid().safeParse(workspaceId).success ? workspaceId : null,
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    try {
      return this.toSnapshot(
        await this.call("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`),
      );
    } catch (err) {
      if (
        err instanceof IntegrationError &&
        err.kind === "Permanent" &&
        /No such subscription/i.test(err.message)
      )
        return null;
      throw err;
    }
  }

  async cancelSubscription(
    subscriptionId: string,
    options: { atPeriodEnd: boolean },
  ): Promise<SubscriptionSnapshot> {
    const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const raw = options.atPeriodEnd
      ? await this.call("POST", path, { cancel_at_period_end: true }, `cancel-${subscriptionId}-period-end`)
      : await this.call("DELETE", path);
    return this.toSnapshot(raw);
  }

  async resumeSubscription(subscriptionId: string): Promise<SubscriptionSnapshot> {
    return this.toSnapshot(
      await this.call("POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        cancel_at_period_end: false,
      }),
    );
  }

  parseWebhook(rawBody: string, signatureHeader: string): Promise<BillingWebhookEvent> {
    try {
      verifyWebhookSignature({
        secret: this.options.webhookSecret,
        rawBody,
        header: signatureHeader,
        nowSeconds: this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
      });
      return Promise.resolve(normalizeStripeEvent(parseStripeJson(rawBody)));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
