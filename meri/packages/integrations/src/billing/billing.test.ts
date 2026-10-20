import { describe, expect, it } from "vitest";
import { FakeBilling } from "../fakes/billing";
import { signWebhook, verifyWebhookSignature } from "./signature";
import { normalizeStripeEvent } from "./stripe-events";

const NOW = new Date("2026-10-20T08:40:00Z");
const now = () => NOW;
const WS = "0192aaaa-0000-7000-8000-000000000000";
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const checkoutBase = {
  workspaceId: WS,
  email: "me@firm.com",
  customerId: null,
  successUrl: "http://localhost:3000/control?billing=ok",
  cancelUrl: "http://localhost:3000/control",
  idempotencyKey: "k-1",
};

describe("webhook signature (Stripe t=…,v1= scheme)", () => {
  const body = '{"id":"evt_1"}';
  it("accepts a valid signature and rejects tampering, a wrong secret, staleness and malformed headers", () => {
    const header = signWebhook("whsec_a", body, nowSeconds);
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_a", rawBody: body, header, nowSeconds });
    }).not.toThrow();
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_a", rawBody: `${body} `, header, nowSeconds });
    }).toThrow(/no matching/);
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_b", rawBody: body, header, nowSeconds });
    }).toThrow(/no matching/);
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_a", rawBody: body, header, nowSeconds: nowSeconds + 301 });
    }).toThrow(/tolerance/);
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_a", rawBody: body, header: "garbage", nowSeconds });
    }).toThrow(/malformed/);
    expect(() => {
      verifyWebhookSignature({
        secret: "whsec_a",
        rawBody: body,
        header: `t=${String(nowSeconds)}`,
        nowSeconds,
      });
    }).toThrow(/malformed/);
    // Stripe may send several v1 signatures during secret rotation: any match is enough.
    const rotated = `${header},v1=${"0".repeat(64)}`;
    expect(() => {
      verifyWebhookSignature({ secret: "whsec_a", rawBody: body, header: rotated, nowSeconds });
    }).not.toThrow();
  });
});

describe("normalizeStripeEvent (ADR 0006 §3)", () => {
  const env = (type: string, object: Record<string, unknown>) => ({
    id: "evt_1",
    type,
    created: nowSeconds,
    data: { object },
  });
  it("checkout: workspace from metadata or client_reference_id, pack code, subscription and customer ids", () => {
    expect(
      normalizeStripeEvent(
        env("checkout.session.completed", {
          id: "cs_1",
          mode: "payment",
          customer: "cus_1",
          subscription: null,
          client_reference_id: WS,
          metadata: { creditPack: "500" },
        }),
      ),
    ).toEqual({
      id: "evt_1",
      type: "checkout.session.completed",
      createdAt: NOW.toISOString(),
      workspaceId: WS,
      customerId: "cus_1",
      subscriptionId: null,
      checkout: { mode: "payment", sessionId: "cs_1", creditPack: "500" },
      invoice: null,
    });
  });
  it("subscription and invoice events, with the newer parent.subscription_details layout as a fallback", () => {
    expect(
      normalizeStripeEvent(
        env("customer.subscription.deleted", {
          id: "sub_1",
          customer: { id: "cus_1" },
          metadata: { workspaceId: WS },
        }),
      ),
    ).toMatchObject({
      type: "customer.subscription.deleted",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      workspaceId: WS,
    });
    expect(
      normalizeStripeEvent(
        env("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 2900 }),
      ),
    ).toMatchObject({
      subscriptionId: "sub_1",
      invoice: { amountPaidCents: 2900 },
      workspaceId: null,
    });
    expect(
      normalizeStripeEvent(
        env("invoice.payment_failed", {
          id: "in_2",
          customer: "cus_1",
          parent: { subscription_details: { subscription: "sub_2", metadata: { workspaceId: WS } } },
        }),
      ),
    ).toMatchObject({ subscriptionId: "sub_2", workspaceId: WS, invoice: { amountPaidCents: 0 } });
  });
  it("unknown types become `other`; a non-uuid workspace is ignored; malformed envelopes or objects throw", () => {
    expect(normalizeStripeEvent(env("customer.created", { id: "cus_1" })).type).toBe("other");
    expect(
      normalizeStripeEvent(
        env("customer.subscription.updated", {
          id: "sub_1",
          customer: "c",
          metadata: { workspaceId: "not-a-uuid" },
        }),
      ).workspaceId,
    ).toBeNull();
    expect(() => normalizeStripeEvent({ id: "x" })).toThrow(/malformed webhook event/);
    expect(() => normalizeStripeEvent(env("checkout.session.completed", { id: "cs" }))).toThrow(
      /malformed checkout/,
    );
    expect(() => normalizeStripeEvent(env("invoice.paid", {}))).toThrow(/malformed invoice/);
    expect(() => normalizeStripeEvent(env("customer.subscription.created", {}))).toThrow(
      /malformed customer/,
    );
  });
});

describe("FakeBilling lifecycle (never charges, Stripe-shaped signed events)", () => {
  it("checkout with trial → trialing with a card; renewal, failure, cancellation, resume and deletion", async () => {
    const billing = new FakeBilling(now, {
      completeUrl: "http://localhost:3000/api/v1/billing/fake/complete",
    });
    const trialEnd = "2026-10-29T08:40:00.000Z";
    const cs = await billing.createCheckoutSession({
      ...checkoutBase,
      plan: "pro",
      interval: "month",
      trialEnd,
    });
    expect(cs.url).toBe(`http://localhost:3000/api/v1/billing/fake/complete?session=${cs.id}`);
    const done = billing.completeCheckout(cs.id);
    const event = await billing.parseWebhook(done.rawBody, done.signature);
    expect(event).toMatchObject({
      type: "checkout.session.completed",
      workspaceId: WS,
      checkout: { mode: "subscription", creditPack: null },
    });
    const subId = event.subscriptionId ?? "";
    expect(await billing.getSubscription(subId)).toMatchObject({
      status: "trialing",
      trialEnd,
      hasPaymentMethod: true,
      plan: "pro",
      workspaceId: WS,
      currentPeriodEnd: trialEnd,
    });

    const paid = await billing.parseWebhook(
      ...(Object.values(billing.simulate("invoice_paid", subId)) as [string, string]),
    );
    expect(paid).toMatchObject({
      type: "invoice.paid",
      subscriptionId: subId,
      invoice: { amountPaidCents: 2900 },
    });
    expect(await billing.getSubscription(subId)).toMatchObject({
      status: "active",
      trialEnd: null,
      currentPeriodEnd: "2026-11-28T08:40:00.000Z",
    });

    await billing.parseWebhook(
      ...(Object.values(billing.simulate("payment_failed", subId)) as [string, string]),
    );
    expect((await billing.getSubscription(subId))?.status).toBe("past_due");

    expect((await billing.cancelSubscription(subId, { atPeriodEnd: true })).cancelAtPeriodEnd).toBe(true);
    expect((await billing.resumeSubscription(subId)).cancelAtPeriodEnd).toBe(false);
    const deleted = await billing.parseWebhook(
      ...(Object.values(billing.simulate("deleted", subId)) as [string, string]),
    );
    expect(deleted).toMatchObject({ type: "customer.subscription.deleted", workspaceId: WS });
    expect((await billing.getSubscription(subId))?.status).toBe("canceled");
    await expect(billing.resumeSubscription(subId)).rejects.toThrow(/already ended/);
    expect((await billing.cancelSubscription(subId, { atPeriodEnd: false })).status).toBe("canceled");
  });

  it("checkout without trial starts active; credit packs pay once; forged or stale webhooks are rejected", async () => {
    const billing = new FakeBilling(now);
    const cs = await billing.createCheckoutSession({
      ...checkoutBase,
      plan: "pro_plus",
      interval: "year",
      trialEnd: null,
    });
    expect(cs.url).toContain("http://localhost:3000/control?billing=ok&session=");
    const ev = await billing.parseWebhook(
      ...(Object.values(billing.completeCheckout(cs.id)) as [string, string]),
    );
    expect(await billing.getSubscription(ev.subscriptionId ?? "")).toMatchObject({
      status: "active",
      interval: "year",
      currentPeriodEnd: "2027-10-20T08:40:00.000Z",
    });

    const pack = await billing.createCreditPackCheckout({ ...checkoutBase, pack: "2000" });
    const packEv = await billing.parseWebhook(
      ...(Object.values(billing.completeCheckout(pack.id)) as [string, string]),
    );
    expect(packEv).toMatchObject({ checkout: { mode: "payment", creditPack: "2000" }, subscriptionId: null });

    const forged = billing.sign(
      "invoice.paid",
      { id: "in_x", customer: "c", subscription: "s", amount_paid: 1 },
      { secret: "whsec_attacker" },
    );
    await expect(billing.parseWebhook(forged.rawBody, forged.signature)).rejects.toMatchObject({
      kind: "Permanent",
    });
    const stale = billing.sign(
      "invoice.paid",
      { id: "in_y", customer: "c", subscription: "s", amount_paid: 1 },
      { atSeconds: nowSeconds - 3600 },
    );
    await expect(billing.parseWebhook(stale.rawBody, stale.signature)).rejects.toThrow(/tolerance/);
    expect(() => billing.completeCheckout("cs_missing")).toThrow(/no such checkout/);
    expect(() => billing.simulate("invoice_paid", "sub_missing")).toThrow(/no such subscription/);
    expect(
      (await billing.createPortalSession({ customerId: "cus_1", returnUrl: "http://x/control" })).url,
    ).toBe("http://x/control?fake_portal=cus_1");
    expect(await billing.getSubscription("nope")).toBeNull();
    expect((await billing.healthCheck()).status).toBe("healthy");
  });
});
