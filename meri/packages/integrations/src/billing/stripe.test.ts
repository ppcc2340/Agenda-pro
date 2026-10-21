import { describe, expect, it } from "vitest";
import { IntegrationError } from "../errors";
import { signWebhook } from "./signature";
import { STRIPE_API_VERSION } from "./stripe-events";
import { StripeBilling, formEncode, type StripePrices } from "./stripe";

const WS = "11111111-1111-4111-8111-111111111111";
const prices: StripePrices = {
  pro: { month: "price_pro_m", year: "price_pro_y" },
  pro_plus: { month: "price_plus_m", year: "price_plus_y" },
  credits: { "500": "price_c500", "2000": "price_c2000" },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams | null;
}

function stub(responses: { status: number; json: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? new URLSearchParams(init.body) : null,
    });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("unexpected call"));
    return Promise.resolve(
      new Response(JSON.stringify(next.json), { status: next.status, headers: next.headers ?? {} }),
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "trialing",
  trial_end: 1_800_000_000,
  cancel_at_period_end: false,
  default_payment_method: "pm_1",
  metadata: { workspaceId: WS },
  items: {
    data: [
      { current_period_end: 1_800_000_000, price: { id: "price_plus_y", recurring: { interval: "year" } } },
    ],
  },
  ...overrides,
});

const make = (fetchImpl: typeof fetch, nowSeconds = () => 1_700_000_000) =>
  new StripeBilling({
    secretKey: "sk_test_x",
    webhookSecret: "whsec_live",
    prices,
    fetch: fetchImpl,
    nowSeconds,
  });

describe("StripeBilling (live adapter, fetch stubbed)", () => {
  it("form-encodes params, skipping null and undefined", () => {
    expect(formEncode({ a: 1, "b[c]": "x y", d: null, e: undefined, f: true })).toBe(
      "a=1&b%5Bc%5D=x+y&f=true",
    );
  });

  it("creates a subscription checkout with tax, metadata, trial and the idempotency key; pins the API version", async () => {
    const { calls, fetchImpl } = stub([
      { status: 200, json: { id: "cs_1", url: "https://checkout.stripe.com/c/1" } },
    ]);
    const session = await make(fetchImpl).createCheckoutSession({
      workspaceId: WS,
      email: "a@b.c",
      customerId: null,
      successUrl: "https://app/ok",
      cancelUrl: "https://app/cancel",
      idempotencyKey: "idem-1",
      plan: "pro",
      cohort: "A",
      interval: "year",
      trialEnd: "2027-01-01T00:00:00.000Z",
    });
    expect(session).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/1" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call?.headers).toMatchObject({
      authorization: "Bearer sk_test_x",
      "stripe-version": STRIPE_API_VERSION,
      "idempotency-key": "idem-1",
    });
    expect(Object.fromEntries(call?.body ?? [])).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_pro_y",
      customer_email: "a@b.c",
      client_reference_id: WS,
      "subscription_data[metadata][workspaceId]": WS,
      "subscription_data[trial_end]": String(Date.parse("2027-01-01T00:00:00.000Z") / 1000),
      "automatic_tax[enabled]": "true",
      "tax_id_collection[enabled]": "true",
    });
  });

  it("reuses an existing customer and omits trial_end when there is none", async () => {
    const { calls, fetchImpl } = stub([{ status: 200, json: { id: "cs_2", url: "u" } }]);
    await make(fetchImpl).createCheckoutSession({
      workspaceId: WS,
      email: "a@b.c",
      customerId: "cus_9",
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "k",
      plan: "pro_plus",
      cohort: "A",
      interval: "month",
      trialEnd: null,
    });
    const body = calls[0]?.body;
    expect(body?.get("customer")).toBe("cus_9");
    expect(body?.has("customer_email")).toBe(false);
    expect(body?.has("subscription_data[trial_end]")).toBe(false);
    expect(body?.get("line_items[0][price]")).toBe("price_plus_m");
  });

  it("creates a one-off credit-pack checkout tagged with the pack", async () => {
    const { calls, fetchImpl } = stub([{ status: 200, json: { id: "cs_3", url: "u" } }]);
    await make(fetchImpl).createCreditPackCheckout({
      workspaceId: WS,
      email: "a@b.c",
      customerId: "cus_1",
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "k",
      pack: "2000",
    });
    const body = calls[0]?.body;
    expect(body?.get("mode")).toBe("payment");
    expect(body?.get("line_items[0][price]")).toBe("price_c2000");
    expect(body?.get("metadata[creditPack]")).toBe("2000");
  });

  it("maps a canonical subscription to a snapshot (plan from the price id, workspace from metadata)", async () => {
    const { calls, fetchImpl } = stub([{ status: 200, json: subscription() }]);
    const snap = await make(fetchImpl).getSubscription("sub_1");
    expect(calls[0]?.method).toBe("GET");
    expect(snap).toEqual({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      plan: "pro_plus",
      interval: "year",
      status: "trialing",
      trialEnd: new Date(1_800_000_000_000).toISOString(),
      currentPeriodEnd: new Date(1_800_000_000_000).toISOString(),
      cancelAtPeriodEnd: false,
      hasPaymentMethod: true,
      workspaceId: WS,
      cohort: "A",
    });
  });

  it("price cohort B (D-102): checkout uses the B price id, snapshots say B, and unconfigured ids are refused", async () => {
    const withB = (fetchImpl: typeof fetch) =>
      new StripeBilling({
        secretKey: "sk_test_x",
        webhookSecret: "whsec_live",
        prices: {
          ...prices,
          b: {
            pro: { month: "price_pro_m_b", year: "price_pro_y_b" },
            pro_plus: { month: "price_plus_m_b", year: "price_plus_y_b" },
          },
        },
        fetch: fetchImpl,
      });
    const base = {
      workspaceId: WS,
      email: "a@b.c",
      customerId: "cus_1",
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "k",
      plan: "pro" as const,
      interval: "month" as const,
      trialEnd: null,
    };
    const { calls, fetchImpl } = stub([{ status: 200, json: { id: "cs_b", url: "u" } }]);
    await withB(fetchImpl).createCheckoutSession({ ...base, cohort: "B" });
    expect(calls[0]?.body).toContainEqual(["line_items[0][price]", "price_pro_m_b"]);
    // Without B prices configured the checkout refuses instead of charging the A price silently.
    await expect(
      make(stub([]).fetchImpl).createCheckoutSession({ ...base, cohort: "B" }),
    ).rejects.toMatchObject({
      kind: "Permanent",
    });
    const adapter = withB(stub([]).fetchImpl);
    const raw = (price: string) => ({
      id: "sub_b",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: false,
      default_payment_method: "pm_1",
      trial_end: null,
      current_period_end: 1_800_000_000,
      metadata: { workspaceId: WS },
      items: { data: [{ price: { id: price }, current_period_end: 1_800_000_000 }] },
    });
    expect(adapter.toSnapshot(raw("price_plus_y_b"))).toMatchObject({
      plan: "pro_plus",
      interval: "year",
      cohort: "B",
    });
    expect(() => adapter.toSnapshot(raw("price_someone_else"))).toThrow(/no known Meri price/);
  });

  it("drops a non-uuid workspace from metadata and maps unknown statuses conservatively", () => {
    const adapter = make(stub([]).fetchImpl);
    const snap = adapter.toSnapshot(
      subscription({
        metadata: { workspaceId: "not-a-uuid" },
        status: "paused",
        default_payment_method: null,
      }),
    );
    expect(snap.workspaceId).toBeNull();
    expect(snap.status).toBe("unpaid");
    expect(snap.hasPaymentMethod).toBe(false);
    expect(adapter.toSnapshot(subscription({ status: "incomplete_expired" })).status).toBe("canceled");
  });

  it("refuses a subscription whose price is not one of Meri's", () => {
    const adapter = make(stub([]).fetchImpl);
    expect(() =>
      adapter.toSnapshot(subscription({ items: { data: [{ price: { id: "price_other" } }] } })),
    ).toThrow(/no known Meri price/);
    expect(() => adapter.toSnapshot({ id: 1 })).toThrow(/malformed/);
  });

  it("returns null for a subscription Stripe does not know", async () => {
    const { fetchImpl } = stub([
      { status: 404, json: { error: { message: "No such subscription: 'sub_x'" } } },
    ]);
    await expect(make(fetchImpl).getSubscription("sub_x")).resolves.toBeNull();
  });

  it("cancels and resumes with the caller's idempotency key (never a fixed one), or deletes immediately", async () => {
    const { calls, fetchImpl } = stub([
      { status: 200, json: subscription({ cancel_at_period_end: true }) },
      { status: 200, json: subscription({ status: "canceled" }) },
      { status: 200, json: subscription() },
    ]);
    const adapter = make(fetchImpl);
    expect(
      (await adapter.cancelSubscription("sub_1", { atPeriodEnd: true, idempotencyKey: "cancel-a" }))
        .cancelAtPeriodEnd,
    ).toBe(true);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body?.get("cancel_at_period_end")).toBe("true");
    expect(calls[0]?.headers["idempotency-key"]).toBe("cancel-a");
    expect(
      (await adapter.cancelSubscription("sub_1", { atPeriodEnd: false, idempotencyKey: "delete-a" })).status,
    ).toBe("canceled");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.headers["idempotency-key"]).toBe("delete-a");
    expect(
      (await adapter.resumeSubscription("sub_1", { idempotencyKey: "resume-a" })).cancelAtPeriodEnd,
    ).toBe(false);
    expect(calls[2]?.body?.get("cancel_at_period_end")).toBe("false");
    expect(calls[2]?.headers["idempotency-key"]).toBe("resume-a");
  });

  it("creates one customer per workspace (keyed), reuses an existing one, and reads checkout sessions back", async () => {
    const { calls, fetchImpl } = stub([
      { status: 200, json: { id: "cus_new" } },
      {
        status: 200,
        json: {
          id: "cs_9",
          mode: "payment",
          payment_status: "unpaid",
          customer: "cus_new",
          metadata: { workspaceId: WS, creditPack: "500" },
        },
      },
      { status: 404, json: { error: { message: "No such checkout.session: 'cs_x'" } } },
    ]);
    const adapter = make(fetchImpl);
    expect(await adapter.ensureCustomer({ workspaceId: WS, email: "a@b.c", customerId: "cus_old" })).toBe(
      "cus_old",
    );
    expect(await adapter.ensureCustomer({ workspaceId: WS, email: "a@b.c", customerId: null })).toBe(
      "cus_new",
    );
    expect(calls[0]?.headers["idempotency-key"]).toBe(`customer-${WS}`);
    expect(calls[0]?.body?.get("metadata[workspaceId]")).toBe(WS);
    expect(await adapter.getCheckoutSession("cs_9")).toEqual({
      id: "cs_9",
      mode: "payment",
      paymentStatus: "unpaid",
      workspaceId: WS,
      customerId: "cus_new",
      creditPack: "500",
    });
    await expect(adapter.getCheckoutSession("cs_x")).resolves.toBeNull();
  });

  it("bounds every request with a timeout (an abort is transient)", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "TimeoutError"));
        });
      })) as typeof fetch;
    const adapter = new StripeBilling({
      secretKey: "k",
      webhookSecret: "w",
      prices,
      fetch: hanging,
      timeoutMs: 20,
    });
    const err = await adapter.getSubscription("sub_1").catch((e: unknown) => e);
    expect((err as IntegrationError).kind).toBe("Transient");
  });

  it("creates portal sessions", async () => {
    const { calls, fetchImpl } = stub([{ status: 200, json: { url: "https://billing.stripe.com/p/1" } }]);
    await expect(
      make(fetchImpl).createPortalSession({ customerId: "cus_1", returnUrl: "r" }),
    ).resolves.toEqual({
      url: "https://billing.stripe.com/p/1",
    });
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
  });

  it.each([
    [429, "RateLimited"],
    [500, "Transient"],
    [503, "Transient"],
    [401, "AuthExpired"],
    [400, "Permanent"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const { fetchImpl } = stub([
      { status, json: { error: { message: "nope" } }, headers: { "retry-after": "2" } },
    ]);
    const err = await make(fetchImpl)
      .createPortalSession({ customerId: "c", returnUrl: "r" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).kind).toBe(kind);
    if (kind === "RateLimited") expect((err as IntegrationError).options.retryAfterMs).toBe(2000);
  });

  it("maps a network failure to Transient", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
    const err = await make(fetchImpl)
      .getSubscription("sub_1")
      .catch((e: unknown) => e);
    expect((err as IntegrationError).kind).toBe("Transient");
  });

  it("reports health from the balance endpoint", async () => {
    const ok = stub([{ status: 200, json: {} }]);
    await expect(make(ok.fetchImpl).healthCheck()).resolves.toMatchObject({ status: "healthy" });
    const down = stub([{ status: 401, json: { error: { message: "Invalid API Key" } } }]);
    await expect(make(down.fetchImpl).healthCheck()).resolves.toMatchObject({ status: "degraded" });
  });

  it("verifies webhooks with the live secret against the wall clock and normalises them", async () => {
    const adapter = make(stub([]).fetchImpl);
    const body = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 1_700_000_000,
      data: {
        object: { id: "sub_1", object: "subscription", customer: "cus_1", metadata: { workspaceId: WS } },
      },
    });
    const event = await adapter.parseWebhook(body, signWebhook("whsec_live", body, 1_700_000_000));
    expect(event).toMatchObject({
      id: "evt_1",
      type: "customer.subscription.updated",
      subscriptionId: "sub_1",
    });
    await expect(adapter.parseWebhook(body, signWebhook("whsec_other", body, 1_700_000_000))).rejects.toThrow(
      /invalid webhook signature/,
    );
    await expect(adapter.parseWebhook(body, signWebhook("whsec_live", body, 1_699_999_000))).rejects.toThrow(
      /tolerance/,
    );
  });
});

describe("StripeBilling.deleteCustomer (F-16, ADR 0007)", () => {
  it("deletes the customer with an idempotency key and treats an already deleted customer as done", async () => {
    const ok = stub([{ status: 200, json: { id: "cus_1", deleted: true } }]);
    await make(ok.fetchImpl).deleteCustomer("cus_1");
    expect(ok.calls[0]).toMatchObject({ method: "DELETE", url: "https://api.stripe.com/v1/customers/cus_1" });
    expect(ok.calls[0]?.headers["idempotency-key"]).toBe("delete-customer-cus_1");
    const gone = stub([{ status: 404, json: { error: { message: "No such customer: 'cus_2'" } } }]);
    await expect(make(gone.fetchImpl).deleteCustomer("cus_2")).resolves.toBeUndefined();
    const down = stub([{ status: 500, json: { error: { message: "boom" } } }]);
    await expect(make(down.fetchImpl).deleteCustomer("cus_3")).rejects.toMatchObject({ kind: "Transient" });
  });
});
