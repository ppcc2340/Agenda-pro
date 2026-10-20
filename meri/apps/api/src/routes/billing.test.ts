import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancellationFeedback,
  creditGrants,
  listAudit,
  listNotifications,
  subscriptions,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import type { FakeBilling, NoopAnalytics } from "@meri/integrations";
import { signWebhook } from "@meri/integrations";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface SubscriptionBody {
  plan: string;
  status: string;
  interval: string | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
  access: { active: boolean; reason: string; trialDaysLeft: number | null };
  entitlements: { maxClients: number; aiCreditsMonthly: number; retentionDays: number; features: string[] };
  credits: { allowance: number; used: number; remaining: number };
}

describe("billing lifecycle (D-058..D-061, D-066, [H1], [M4], [M5])", () => {
  let t: TestApp;
  let fake: FakeBilling;
  let analytics: NoopAnalytics;
  let a: AccountIdentity;
  let cookieA: string;
  let key = 0;
  const idem = () => ({ ...csrf, "idempotency-key": `k-${String(++key)}` });
  const sub = async (cookie = cookieA) =>
    (await t.app.inject({ url: "/v1/billing/subscription", headers: { cookie } })).json<SubscriptionBody>();
  const post = (url: string, cookie: string, payload?: unknown) =>
    t.app.inject({ method: "POST", url, headers: { cookie, ...idem() }, ...(payload ? { payload } : {}) });
  const hook = (signed: { rawBody: string; signature: string }) =>
    t.app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": signed.signature, "content-type": "application/json" },
      payload: signed.rawBody,
    });
  const completeVia = async (url: string, cookie: string) => {
    const path = new URL(url).pathname.replace(/^\/api/, "") + new URL(url).search;
    return t.app.inject({ url: path, headers: { cookie } });
  };
  const subscriptionIdOf = async (account: AccountIdentity) =>
    (await withWorkspace(t.handle.db, account.workspaceId, (tx) => tx.query.subscriptions.findFirst()))
      ?.stripeSubscriptionId ?? "";

  beforeAll(async () => {
    t = await createTestApp();
    fake = t.integrations.billing as FakeBilling;
    analytics = t.integrations.analytics as NoopAnalytics;
    a = await t.createAccount("bill");
    cookieA = await t.cookieFor(a);
  });
  afterAll(() => t.close());

  it("a new account is on an active 14-day trial with the trial allowance", async () => {
    expect(await sub()).toMatchObject({
      plan: "trial",
      status: "trialing",
      hasPaymentMethod: false,
      access: { active: true, reason: "trial", trialDaysLeft: 14 },
      entitlements: { maxClients: 25, aiCreditsMonthly: 300 },
      credits: { allowance: 300, used: 0, remaining: 300 },
    });
  });

  it("billing writes require an Idempotency-Key", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: { cookie: cookieA, ...csrf },
      payload: { plan: "pro", interval: "month" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("checkout carries the local trial; the simulated completion runs the real webhook handler once", async () => {
    const res = await post("/v1/billing/checkout", cookieA, { plan: "pro", interval: "month" });
    expect(res.statusCode).toBe(200);
    const url = res.json<{ url: string }>().url;
    expect(url).toContain("/api/v1/billing/fake/complete?session=");
    const session = [...fake.sessions.values()].find((s) => s.workspaceId === a.workspaceId);
    expect(session?.trialEnd).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());

    // Another workspace cannot complete A's checkout.
    const b = await t.createAccount("bill-b");
    expect((await completeVia(url, await t.cookieFor(b))).statusCode).toBe(404);

    const done = await completeVia(url, cookieA);
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe("http://localhost:3000/control?billing=success#plan");
    expect(await sub()).toMatchObject({
      plan: "pro",
      status: "trialing",
      interval: "month",
      hasPaymentMethod: true,
      access: { active: true, reason: "trial_card_on_file" },
      // Trial with a card: the chosen plan's limits, the trial's allowance.
      entitlements: { maxClients: 25, aiCreditsMonthly: 300 },
    });
    // Completing again is a no-op.
    expect((await completeVia(url, cookieA)).statusCode).toBe(303);
    const audits = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 50));
    expect(audits.items.filter((i) => i.action === "billing.subscription_synced")).toHaveLength(1);
    expect(audits.items.find((i) => i.action === "billing.subscription_synced")?.actor).toBe("system");
  });

  it("a second checkout while subscribed is refused (plan changes go through the portal)", async () => {
    const res = await post("/v1/billing/checkout", cookieA, { plan: "pro_plus", interval: "year" });
    expect(res.statusCode).toBe(409);
    const portal = await post("/v1/billing/portal", cookieA);
    expect(portal.statusCode).toBe(200);
    expect(portal.json<{ url: string }>().url).toContain("fake_portal=");
  });

  it("the first paid invoice activates the plan; a replayed event changes nothing ([H1])", async () => {
    const subscriptionId = await subscriptionIdOf(a);
    const paid = fake.simulate("invoice_paid", subscriptionId);
    const first = await hook(paid);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ status: string }>().status).toBe("applied");
    expect(await sub()).toMatchObject({ status: "active", entitlements: { aiCreditsMonthly: 1500 } });
    const replay = await hook(paid);
    expect(replay.json<{ status: string }>().status).toBe("duplicate");
    expect(analytics.events.filter((e) => e.event === "subscription_started")).toEqual([
      { event: "subscription_started", distinctId: a.workspaceId, props: { plan: "pro", interval: "month" } },
    ]);
    // A renewal is not a new subscription.
    await hook(fake.simulate("invoice_paid", subscriptionId));
    expect(analytics.events.filter((e) => e.event === "subscription_started")).toHaveLength(1);
  });

  it("rejects a bad or missing signature with 400 and never applies it", async () => {
    const subscriptionId = await subscriptionIdOf(a);
    const forged = fake.sign(
      "customer.subscription.deleted",
      { id: subscriptionId, object: "subscription", customer: "cus_x" },
      { secret: "whsec_attacker" },
    );
    expect((await hook(forged)).statusCode).toBe(400);
    const missing = await t.app.inject({ method: "POST", url: "/webhooks/stripe", payload: "{}" });
    expect(missing.statusCode).toBe(400);
    const garbage = "not json";
    const signedGarbage = {
      rawBody: garbage,
      signature: signWebhook(fake.webhookSecret, garbage, Math.floor(NOW.getTime() / 1000)),
    };
    expect((await hook(signedGarbage)).statusCode).toBe(400);
    expect((await sub()).status).toBe("active");
  });

  it("a payment failure keeps access (past_due) and notifies once per event", async () => {
    const subscriptionId = await subscriptionIdOf(a);
    await hook(fake.simulate("payment_failed", subscriptionId));
    expect(await sub()).toMatchObject({ status: "past_due", access: { active: true, reason: "past_due" } });
    const notes = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      listNotifications(tx, a.workspaceId, { limit: 20 }),
    );
    expect(notes.items.filter((n) => n.template === "billing.payment_failed")).toHaveLength(1);
    await hook(fake.simulate("invoice_paid", subscriptionId));
    expect((await sub()).status).toBe("active");
  });

  it("cancel stores the survey (comment never in analytics or audit) and reactivate undoes it", async () => {
    const comment = "Demasiado caro para Estudio Norte";
    const res = await post("/v1/billing/cancel", cookieA, { reason: "price", comment });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    const feedback = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      tx.select().from(cancellationFeedback),
    );
    expect(feedback).toMatchObject([{ reason: "price", comment }]);
    expect(analytics.events.filter((e) => e.event === "subscription_cancelled")).toEqual([
      { event: "subscription_cancelled", distinctId: a.workspaceId, props: { reason: "price" } },
    ]);
    expect(JSON.stringify(analytics.events)).not.toContain("Estudio Norte");
    const audits = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 50));
    expect(JSON.stringify(audits.items)).not.toContain("Estudio Norte");
    expect(analytics.errors).toEqual([]);

    const again = await post("/v1/billing/reactivate", cookieA);
    expect(again.json()).toEqual({ status: "resumed", url: null });
    expect((await sub()).cancelAtPeriodEnd).toBe(false);
  });

  it("an older event than the last applied one has no effect ([H1])", async () => {
    const subscriptionId = await subscriptionIdOf(a);
    const old = fake.sign(
      "customer.subscription.deleted",
      { id: subscriptionId, object: "subscription", customer: "cus_x" },
      { atSeconds: Math.floor(NOW.getTime() / 1000) - 3600 },
    );
    // Signed an hour ago: also outside the 5-minute signature tolerance → rejected before any effect.
    expect((await hook(old)).statusCode).toBe(400);
    await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      tx.update(subscriptions).set({ lastEventAt: new Date(NOW.getTime() + 60_000) }),
    );
    const stale = await hook(fake.simulate("updated", subscriptionId));
    expect(stale.json<{ status: string }>().status).toBe("ignored");
    await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      tx.update(subscriptions).set({ lastEventAt: NOW }),
    );
  });

  it("events for unknown workspaces or foreign customers are acknowledged without effects", async () => {
    const stranger = fake.sign("customer.subscription.updated", {
      id: "sub_unknown",
      object: "subscription",
    });
    expect((await hook(stranger)).json<{ status: string }>().status).toBe("ignored");
    // A subscription whose metadata names workspace C while C is already linked to another customer.
    const c = await t.createAccount("bill-c");
    await withWorkspace(t.handle.db, c.workspaceId, (tx) =>
      tx.update(subscriptions).set({ stripeCustomerId: "cus_C" }),
    );
    fake.subscriptions.set("sub_foreign", {
      customerId: "cus_attacker",
      subscriptionId: "sub_foreign",
      plan: "pro_plus",
      interval: "year",
      status: "active",
      trialEnd: null,
      currentPeriodEnd: new Date(NOW.getTime() + 365 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
      hasPaymentMethod: true,
      workspaceId: c.workspaceId,
    });
    const res = await hook(fake.simulate("updated", "sub_foreign"));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe("ignored");
    expect(await sub(await t.cookieFor(c))).toMatchObject({
      plan: "trial",
      entitlements: { aiCreditsMonthly: 300 },
    });
  });

  it("credit packs: checkout in payment mode, granted once even if the event is replayed", async () => {
    const res = await post("/v1/billing/credit-packs", cookieA, { pack: "500" });
    expect(res.statusCode).toBe(200);
    const sessionId = new URL(res.json<{ url: string }>().url).searchParams.get("session") ?? "";
    const signed = fake.completeCheckout(sessionId);
    expect((await hook(signed)).json<{ status: string }>().status).toBe("applied");
    expect((await hook(signed)).json<{ status: string }>().status).toBe("duplicate");
    expect((await sub()).credits.allowance).toBe(2000);
    const grants = await withWorkspace(t.handle.db, a.workspaceId, (tx) => tx.select().from(creditGrants));
    expect(grants).toHaveLength(1);
  });

  it("deletion at the provider ends access without downgrading entitlements; reactivation opens a new checkout", async () => {
    const subscriptionId = await subscriptionIdOf(a);
    await hook(fake.simulate("deleted", subscriptionId));
    expect(await sub()).toMatchObject({
      status: "canceled",
      access: { active: false, reason: "canceled" },
      entitlements: { aiCreditsMonthly: 1500 },
    });
    const again = await post("/v1/billing/reactivate", cookieA);
    expect(again.json<{ status: string; url: string }>()).toMatchObject({ status: "checkout" });
    // Without access, credits cannot be bought.
    expect((await post("/v1/billing/credit-packs", cookieA, { pack: "500" })).statusCode).toBe(402);
  });

  it("checkout without enough trial left charges now ([M10])", async () => {
    const d = await t.createAccount("bill-d");
    await withWorkspace(t.handle.db, d.workspaceId, (tx) =>
      tx.update(subscriptions).set({ trialEndsAt: new Date(NOW.getTime() + 24 * 3_600_000) }),
    );
    const res = await post("/v1/billing/checkout", await t.cookieFor(d), {
      plan: "pro_plus",
      interval: "year",
    });
    expect(res.statusCode).toBe(200);
    const session = [...fake.sessions.values()].find((s) => s.workspaceId === d.workspaceId);
    expect(session?.trialEnd).toBeNull();
  });
  it("the account export carries the plan and the cancellation survey ([M11])", async () => {
    const res = await t.app.inject({ url: "/v1/account/export", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ billing: unknown }>().billing).toMatchObject({
      plan: "pro",
      cancellationFeedback: [{ reason: "price", comment: "Demasiado caro para Estudio Norte" }],
    });
  });

  it("deleting the account cancels the provider subscription immediately ([M11])", async () => {
    const e = await t.createAccount("bill-e");
    const cookie = await t.cookieFor(e);
    const url = (await post("/v1/billing/checkout", cookie, { plan: "pro", interval: "month" })).json<{
      url: string;
    }>().url;
    await completeVia(url, cookie);
    const subscriptionId = await subscriptionIdOf(e);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("trialing");
    const del = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } });
    expect(del.statusCode).toBe(204);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("canceled");
    const audits = await withWorkspace(t.handle.db, e.workspaceId, (tx) => listAudit(tx, e.workspaceId, 50));
    expect(audits.items.find((i) => i.action === "billing.cancelled_on_deletion")?.after).toMatchObject({
      cancelled: true,
    });
  });

  /** A fresh workspace with a card on file (simulated hosted checkout through the real handler). */
  const subscribed = async (label: string) => {
    const account = await t.createAccount(label);
    const cookie = await t.cookieFor(account);
    const url = (await post("/v1/billing/checkout", cookie, { plan: "pro", interval: "month" })).json<{
      url: string;
    }>().url;
    await completeVia(url, cookie);
    return { account, cookie, subscriptionId: await subscriptionIdOf(account) };
  };

  it("cancel → reactivate → cancel sends a distinct idempotency key each time and really cancels (review H1)", async () => {
    const { cookie, subscriptionId } = await subscribed("bill-h1");
    const before = fake.cancelKeys.length;
    expect((await post("/v1/billing/cancel", cookie, { reason: "price" })).json()).toMatchObject({
      cancelAtPeriodEnd: true,
    });
    await post("/v1/billing/reactivate", cookie);
    expect((await post("/v1/billing/cancel", cookie, { reason: "other" })).json()).toMatchObject({
      cancelAtPeriodEnd: true,
    });
    const keys = fake.cancelKeys.slice(before);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(fake.subscriptions.get(subscriptionId)?.cancelAtPeriodEnd).toBe(true);
  });

  it("the workspace comes from the provider's subscription, never from the event body ([H1])", async () => {
    const { account: owner, subscriptionId } = await subscribed("bill-canon-a");
    const other = await t.createAccount("bill-canon-b");
    const forged = fake.sign("customer.subscription.updated", {
      id: subscriptionId,
      object: "subscription",
      customer: "cus_x",
      metadata: { workspaceId: other.workspaceId },
    });
    expect((await hook(forged)).json<{ status: string }>().status).toBe("applied");
    expect((await sub(await t.cookieFor(other))).plan).toBe("trial");
    expect((await sub(await t.cookieFor(owner))).plan).toBe("pro");
  });

  it("a checkout whose metadata names another workspace than its subscription is ignored", async () => {
    const { subscriptionId } = await subscribed("bill-meta-a");
    const other = await t.createAccount("bill-meta-b");
    const forged = fake.sign("checkout.session.completed", {
      id: "cs_forged",
      object: "checkout.session",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_x",
      subscription: subscriptionId,
      metadata: { workspaceId: other.workspaceId },
    });
    expect((await hook(forged)).json<{ status: string }>().status).toBe("ignored");
    expect((await sub(await t.cookieFor(other))).plan).toBe("trial");
  });

  it("packs: an unpaid (asynchronous) checkout grants nothing until the payment settles, then once ([M1])", async () => {
    const e = await t.createAccount("bill-async");
    const cookie = await t.cookieFor(e);
    const res = await post("/v1/billing/credit-packs", cookie, { pack: "2000" });
    const sessionId = new URL(res.json<{ url: string }>().url).searchParams.get("session") ?? "";
    const pending = await hook(fake.completeCheckout(sessionId, { paymentStatus: "unpaid" }));
    expect(pending.json<{ status: string }>().status).toBe("ignored");
    expect((await sub(cookie)).credits.allowance).toBe(300);
    expect((await hook(fake.settleAsyncPayment(sessionId))).json<{ status: string }>().status).toBe(
      "applied",
    );
    expect((await sub(cookie)).credits.allowance).toBe(2300);
    // A replayed `completed` (now paid at the provider) never grants twice: grants are keyed by session.
    const again = fake.resendCheckout(sessionId);
    expect((await hook(again)).json<{ status: string }>().status).toBe("applied");
    expect((await sub(cookie)).credits.allowance).toBe(2300);
  });

  it("a forged pack event for a session the provider does not know grants nothing (fake secret is public, L1)", async () => {
    const f = await t.createAccount("bill-forged-pack");
    const forged = fake.sign("checkout.session.completed", {
      id: "cs_never_created",
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      metadata: { workspaceId: f.workspaceId, creditPack: "2000" },
    });
    expect((await hook(forged)).json<{ status: string }>().status).toBe("ignored");
    expect((await sub(await t.cookieFor(f))).credits.allowance).toBe(300);
  });

  it("two completed checkouts: the first is the plan, the duplicate is cancelled at the provider (M3)", async () => {
    const g = await t.createAccount("bill-dup");
    const cookie = await t.cookieFor(g);
    const first = (await post("/v1/billing/checkout", cookie, { plan: "pro", interval: "month" })).json<{
      url: string;
    }>().url;
    const second = (await post("/v1/billing/checkout", cookie, { plan: "pro_plus", interval: "year" })).json<{
      url: string;
    }>().url;
    await completeVia(first, cookie);
    const kept = await subscriptionIdOf(g);
    await completeVia(second, cookie);
    expect(await subscriptionIdOf(g)).toBe(kept);
    expect((await sub(cookie)).plan).toBe("pro");
    const duplicates = [...fake.subscriptions.values()].filter(
      (x) => x.workspaceId === g.workspaceId && x.subscriptionId !== kept,
    );
    expect(duplicates.map((d) => d.status)).toEqual(["canceled"]);
    // Both checkouts used the same provider customer, created before the first one.
    expect(
      new Set(
        [...fake.sessions.values()].filter((x) => x.workspaceId === g.workspaceId).map((x) => x.customerId),
      ).size,
    ).toBe(1);
  });

  it("a live subscription of a deleted workspace is cancelled when its next event arrives (deletion backstop, M2)", async () => {
    const { cookie, subscriptionId } = await subscribed("bill-orphan");
    // Simulate a cancellation that failed at deletion time: the provider subscription is still live.
    const del = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } });
    expect(del.statusCode).toBe(204);
    const s = fake.subscriptions.get(subscriptionId);
    if (s) fake.subscriptions.set(subscriptionId, { ...s, status: "active" });
    const res = await hook(fake.simulate("invoice_paid", subscriptionId));
    expect(res.json<{ status: string }>().status).toBe("ignored");
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe("canceled");
  });

  it("an older invoice event keeps its own effects (payment-failed notice) without moving the mirror (review M2)", async () => {
    const { account, subscriptionId } = await subscribed("bill-stale");
    await withWorkspace(t.handle.db, account.workspaceId, (tx) =>
      tx.update(subscriptions).set({ lastEventAt: new Date(NOW.getTime() + 60_000) }),
    );
    const res = await hook(fake.simulate("payment_failed", subscriptionId));
    expect(res.json<{ status: string }>().status).toBe("ignored");
    const notes = await withWorkspace(t.handle.db, account.workspaceId, (tx) =>
      listNotifications(tx, account.workspaceId, { limit: 20 }),
    );
    expect(notes.items.filter((n) => n.template === "billing.payment_failed")).toHaveLength(1);
  });

  it("every billing write requires an Idempotency-Key", async () => {
    for (const [url, payload] of [
      ["/v1/billing/cancel", { reason: "price" }],
      ["/v1/billing/reactivate", undefined],
      ["/v1/billing/credit-packs", { pack: "500" }],
      ["/v1/billing/portal", undefined],
    ] as const) {
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { cookie: cookieA, ...csrf },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, url).toBe(400);
    }
  });
});
