import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../client";
import { newId, type UserId, type WorkspaceId } from "../ids";
import { aiUsage, billingRollups, cancellationFeedback, creditGrants, tasks, valueEvents } from "../schema";
import { TEST_ADMIN_URL, TEST_APP_URL } from "../test/urls";
import { ADMIN_WORKSPACE_CONTEXT, withWorkspace } from "../workspace";
import { bootstrapAccount, getMe, hardDeleteAccountByEmail } from "./accounts";
import { creditsFor, recordAiUsage } from "./ai-usage";
import {
  applySubscriptionSnapshot,
  countAiOperations,
  effectiveRetentionDays,
  getAccess,
  getCreditBalance,
  getEntitlements,
  getSubscription,
  grantCreditPack,
  isWorkspaceLive,
  linkStripeCustomer,
  listCancellationFeedback,
  recordCancellationFeedback,
  recordStripeEvent,
  type SnapshotInput,
} from "./billing";
import { getRollup, listRollupsForPeriod, periodAiTotals, upsertRollup } from "./rollups";
import { deleteValueEvent, listValueEvents, recordValueEvent, updateValueQuantity } from "./value-events";

const now = new Date("2026-10-20T08:40:00Z");
const snap = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  customerId: "cus_A",
  subscriptionId: "sub_A",
  plan: "pro",
  interval: "month",
  status: "active",
  trialEnd: null,
  currentPeriodEnd: "2026-11-20T08:40:00.000Z",
  cancelAtPeriodEnd: false,
  hasPaymentMethod: true,
  ...overrides,
});

describe("billing repos (phase 4)", () => {
  let handle: DbHandle;
  let admin: DbHandle;
  let wsA: WorkspaceId;
  let wsB: WorkspaceId;
  let userA: UserId;
  const emails: string[] = [];
  const A = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(handle.db, wsA, fn);
  const B = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(handle.db, wsB, fn);

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    admin = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
    emails.push(`bill-a-${newId()}@test.local`, `bill-b-${newId()}@test.local`);
    const a = await bootstrapAccount(handle.db, { email: emails[0] ?? "", now });
    wsA = a.workspaceId;
    userA = a.userId;
    wsB = (await bootstrapAccount(handle.db, { email: emails[1] ?? "", now })).workspaceId;
  });
  afterAll(async () => {
    for (const e of emails) await hardDeleteAccountByEmail(admin.db, e);
    await admin.close();
    await handle.close();
  });

  it("bootstraps the trial catalogue row and an active 14-day trial", async () => {
    const ent = await A((tx) => getEntitlements(tx, wsA));
    expect(ent).toMatchObject({ maxClients: 25, aiCreditsMonthly: 300, retentionDays: 90, features: [] });
    const access = await A((tx) => getAccess(tx, wsA, now));
    expect(access).toEqual({ active: true, reason: "trial", trialDaysLeft: 14 });
    expect((await getMe(handle.db, userA, wsA))?.entitlements.maxClients).toBe(25);
  });

  it("a card during the trial keeps the trial allowance with the chosen plan's limits", async () => {
    const r = await A((tx) =>
      applySubscriptionSnapshot(
        tx,
        wsA,
        snap({ status: "trialing", plan: "pro_plus", trialEnd: "2026-11-03T08:40:00.000Z" }),
        {
          eventAt: new Date("2026-10-20T08:00:00Z"),
          now,
        },
      ),
    );
    expect(r.applied).toBe(true);
    const ent = await A((tx) => getEntitlements(tx, wsA));
    expect(ent).toMatchObject({ maxClients: 100, aiCreditsMonthly: 300, retentionDays: 365 });
    expect(ent.features).toEqual(["briefings_unlimited", "advanced_exports"]);
    expect(await A((tx) => getAccess(tx, wsA, new Date("2026-11-10T00:00:00Z")))).toMatchObject({
      active: true,
      reason: "trial_card_on_file",
    });
  });

  it("drops events older than the last applied one and refuses another customer ([H1])", async () => {
    const stale = await A((tx) =>
      applySubscriptionSnapshot(tx, wsA, snap({ status: "canceled" }), {
        eventAt: new Date("2026-10-19T00:00:00Z"),
        now,
      }),
    );
    expect(stale).toEqual({ applied: false, reason: "stale" });
    const foreign = await A((tx) =>
      applySubscriptionSnapshot(tx, wsA, snap({ customerId: "cus_OTHER" }), { eventAt: now, now }),
    );
    expect(foreign).toEqual({ applied: false, reason: "customer_mismatch" });
    expect((await A((tx) => getSubscription(tx, wsA)))?.status).toBe("trialing");
  });

  it("active Pro+ → Pro downgrade starts the 30-day retention grace; cancel never downgrades ([H2])", async () => {
    await A((tx) => applySubscriptionSnapshot(tx, wsA, snap({ plan: "pro_plus" }), { eventAt: now, now }));
    expect((await A((tx) => getEntitlements(tx, wsA))).aiCreditsMonthly).toBe(5000);
    const later = new Date("2026-10-21T08:40:00Z");
    await A((tx) =>
      applySubscriptionSnapshot(tx, wsA, snap({ plan: "pro" }), { eventAt: later, now: later }),
    );
    const ent = await A((tx) => getEntitlements(tx, wsA));
    expect(ent).toMatchObject({ retentionDays: 90, previousRetentionDays: 365, aiCreditsMonthly: 1500 });
    expect(ent.retentionGraceUntil?.toISOString()).toBe("2026-11-20T08:40:00.000Z");
    expect(effectiveRetentionDays(ent, new Date("2026-11-01T00:00:00Z"))).toBe(365);
    expect(effectiveRetentionDays(ent, new Date("2026-11-21T00:00:00Z"))).toBe(90);

    const cancelAt = new Date("2026-10-22T08:40:00Z");
    const r = await A((tx) =>
      applySubscriptionSnapshot(tx, wsA, snap({ plan: "pro", status: "canceled" }), {
        eventAt: cancelAt,
        now: cancelAt,
      }),
    );
    expect(r.applied && r.entitlementsChanged).toBe(false);
    expect((await A((tx) => getEntitlements(tx, wsA))).aiCreditsMonthly).toBe(1500);
    expect(await A((tx) => getAccess(tx, wsA, cancelAt))).toMatchObject({
      active: false,
      reason: "canceled",
    });
  });

  it("links the provider customer only once", async () => {
    expect(await B((tx) => linkStripeCustomer(tx, wsB, "cus_B"))).toBe(true);
    expect(await B((tx) => linkStripeCustomer(tx, wsB, "cus_X"))).toBe(false);
    expect((await B((tx) => getSubscription(tx, wsB)))?.stripeCustomerId).toBe("cus_B");
  });

  it("records a provider event id once (webhook idempotency)", async () => {
    const id = `evt_${newId()}`;
    expect(await A((tx) => recordStripeEvent(tx, id, "invoice.paid", now))).toBe(true);
    expect(await B((tx) => recordStripeEvent(tx, id, "invoice.paid", now))).toBe(false);
  });

  it("knows live, unknown and deleted workspaces", async () => {
    expect(await isWorkspaceLive(handle.db, wsA)).toBe(true);
    expect(await isWorkspaceLive(handle.db, newId() as WorkspaceId)).toBe(false);
  });

  it("credit balance = plan allowance + packs of the month − usage; a pack is granted once per event", async () => {
    await B((tx) =>
      recordAiUsage(
        tx,
        wsB,
        {
          operation: "brief_client",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costMicroUsd: 900,
        },
        now,
      ),
    );
    await B((tx) =>
      recordAiUsage(
        tx,
        wsB,
        {
          operation: "capture.parse",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costMicroUsd: 10,
        },
        now,
      ),
    );
    await B((tx) =>
      recordAiUsage(
        tx,
        wsB,
        {
          operation: "extract_commitments",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costMicroUsd: 10,
          credits: 0,
        },
        now,
      ),
    );
    expect(creditsFor("followup_draft")).toBe(3);
    expect(creditsFor("unknown.op")).toBe(0);
    const eventId = `evt_${newId()}`;
    expect(
      await B((tx) =>
        grantCreditPack(
          tx,
          wsB,
          { pack: "500", credits: 500, sourceEventId: eventId, purchasedAt: now },
          now,
        ),
      ),
    ).toBe(true);
    expect(
      await B((tx) =>
        grantCreditPack(
          tx,
          wsB,
          { pack: "500", credits: 500, sourceEventId: eventId, purchasedAt: now },
          now,
        ),
      ),
    ).toBe(false);
    const balance = await B((tx) => getCreditBalance(tx, wsB, now));
    expect(balance).toMatchObject({ allowance: 800, used: 5.2, remaining: 794.8 });
    // Next month: the pack and the usage no longer count ([L16]).
    expect(await B((tx) => getCreditBalance(tx, wsB, new Date("2026-11-02T00:00:00Z")))).toMatchObject({
      allowance: 300,
      used: 0,
    });
    expect(await B((tx) => countAiOperations(tx, wsB, "brief_client", "2026-10"))).toBe(1);
    expect(await B((tx) => periodAiTotals(tx, wsB, "2026-10"))).toEqual({ credits: 5.2, costMicroUsd: 920 });
    // Isolation: A sees none of B's usage or packs.
    expect((await A((tx) => getCreditBalance(tx, wsA, now))).used).toBe(0);
    expect(await A((tx) => tx.select().from(creditGrants))).toEqual([]);
  });

  it("stores the cancellation survey trimmed and capped, visible only to its workspace", async () => {
    await A((tx) =>
      recordCancellationFeedback(tx, wsA, { reason: "price", comment: `  ${"x".repeat(600)} ` }, now),
    );
    await A((tx) => recordCancellationFeedback(tx, wsA, { reason: "other", comment: "   " }, now));
    const rows = await A((tx) => listCancellationFeedback(tx, wsA));
    expect(rows.map((r) => r.reason).sort()).toEqual(["other", "price"]);
    expect(rows.find((r) => r.reason === "price")?.comment).toHaveLength(500);
    expect(rows.find((r) => r.reason === "other")?.comment).toBeNull();
    expect(await B((tx) => listCancellationFeedback(tx, wsB))).toEqual([]);
    expect(await B((tx) => tx.select().from(cancellationFeedback))).toEqual([]);
  });

  it("value events: one per entity, deleted by undo, labelled from the workspace's own rows, isolated", async () => {
    const taskId = newId();
    await A((tx) => tx.insert(tasks).values({ id: taskId, workspaceId: wsA, title: "Informe trimestral" }));
    const ev = {
      type: "deadline_risk_flagged",
      entityType: "task",
      entityId: taskId,
      quantity: 1,
      method: "task_flagged_at_risk_by_planner",
    } as const;
    expect(await A((tx) => recordValueEvent(tx, wsA, ev, now))).toBe(true);
    expect(await A((tx) => recordValueEvent(tx, wsA, ev, now))).toBe(false);
    const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
    const listed = await A((tx) => listValueEvents(tx, wsA, range));
    expect(listed).toEqual([{ ...ev, occurredAt: now, label: "Informe trimestral" }]);
    expect(await B((tx) => listValueEvents(tx, wsB, range))).toEqual([]);
    expect(await B((tx) => deleteValueEvent(tx, wsB, "deadline_risk_flagged", taskId))).toBe(0);
    expect(await A((tx) => deleteValueEvent(tx, wsA, "deadline_risk_flagged", taskId))).toBe(1);
    expect(await A((tx) => recordValueEvent(tx, wsA, ev, now))).toBe(true);
    // An unknown method (older data) is skipped, never mis-reported.
    await A((tx) =>
      tx.insert(valueEvents).values({
        id: newId(),
        workspaceId: wsA,
        type: "commitment_saved",
        entityType: "commitment",
        entityId: newId(),
        method: "legacy",
        createdAt: now,
      }),
    );
    expect(await A((tx) => listValueEvents(tx, wsA, range))).toHaveLength(1);
  });

  it("rollups upsert per workspace and period; the operator listing needs the admin context", async () => {
    const input = {
      period: "2026-10",
      plan: "pro",
      charged: true,
      creditsUsed: 12.5,
      aiCostMicroUsd: 1_000_000,
      revenueMicroUsd: 29_000_000,
      infraCostMicroUsd: 3_000_000,
      paymentFeeMicroUsd: 1_141_000,
      grossMarginPct: 82.8,
      marginAlarm: false,
    };
    await A((tx) => upsertRollup(tx, wsA, input, now));
    await A((tx) => upsertRollup(tx, wsA, { ...input, grossMarginPct: 60, marginAlarm: true }, now));
    expect(await A((tx) => getRollup(tx, wsA, "2026-10"))).toMatchObject({
      grossMarginPct: 60,
      marginAlarm: true,
    });
    expect(await B((tx) => getRollup(tx, wsB, "2026-10"))).toBeNull();
    expect(await B((tx) => tx.select().from(billingRollups))).toEqual([]);
    const all = await listRollupsForPeriod(admin.db, "2026-10");
    expect(all.filter((r) => r.workspaceId === wsA)).toHaveLength(1);
    // The application role never gets a cross-tenant view, even when it asks for the admin context.
    expect(await listRollupsForPeriod(handle.db, "2026-10")).toEqual([]);
  });

  it("B cannot write billing rows into A", async () => {
    await expect(
      B((tx) =>
        tx
          .insert(aiUsage)
          .values({ id: newId(), workspaceId: wsA, operation: "x", model: "m", period: "2026-10" }),
      ),
    ).rejects.toThrow();
    await expect(
      B((tx) =>
        grantCreditPack(
          tx,
          wsA,
          { pack: "500", credits: 500, sourceEventId: `evt_${newId()}`, purchasedAt: now },
          now,
        ),
      ),
    ).rejects.toThrow();
  });

  it("a second live subscription is refused as a duplicate; a canceled one may be replaced", async () => {
    const c = (await bootstrapAccount(handle.db, { email: `bill-c-${newId()}@test.local`, now })).workspaceId;
    const inC = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(handle.db, c, fn);
    expect(
      (
        await inC((tx) =>
          applySubscriptionSnapshot(tx, c, snap({ customerId: "cus_C", subscriptionId: "sub_1" }), {
            eventAt: null,
            now,
          }),
        )
      ).applied,
    ).toBe(true);
    expect(
      await inC((tx) =>
        applySubscriptionSnapshot(tx, c, snap({ customerId: "cus_C", subscriptionId: "sub_2" }), {
          eventAt: null,
          now,
        }),
      ),
    ).toEqual({
      applied: false,
      reason: "duplicate_subscription",
    });
    await inC((tx) =>
      applySubscriptionSnapshot(
        tx,
        c,
        snap({ customerId: "cus_C", subscriptionId: "sub_1", status: "canceled" }),
        { eventAt: null, now },
      ),
    );
    expect(
      (
        await inC((tx) =>
          applySubscriptionSnapshot(tx, c, snap({ customerId: "cus_C", subscriptionId: "sub_3" }), {
            eventAt: null,
            now,
          }),
        )
      ).applied,
    ).toBe(true);
  });

  it("a pack counts in the month it was bought, even when processed after midnight ([L16])", async () => {
    const d = (await bootstrapAccount(handle.db, { email: `bill-d-${newId()}@test.local`, now })).workspaceId;
    const late = new Date("2026-11-01T00:30:00Z");
    await withWorkspace(handle.db, d, (tx) =>
      grantCreditPack(
        tx,
        d,
        {
          pack: "500",
          credits: 500,
          sourceEventId: `evt_${newId()}`,
          purchasedAt: new Date("2026-10-31T23:50:00Z"),
        },
        late,
      ),
    );
    expect((await withWorkspace(handle.db, d, (tx) => getCreditBalance(tx, d, now))).allowance).toBe(800);
    expect((await withWorkspace(handle.db, d, (tx) => getCreditBalance(tx, d, late))).allowance).toBe(300);
  });

  it("correcting a counted quantity keeps the event in its original week", async () => {
    const entity = newId();
    const ev = {
      type: "untracked_time_recovered",
      entityType: "time_entry",
      entityId: entity,
      quantity: 60,
      method: "inferred_time_approved",
    } as const;
    await A((tx) => recordValueEvent(tx, wsA, ev, now));
    expect(await A((tx) => updateValueQuantity(tx, wsA, "untracked_time_recovered", entity, 45))).toBe(1);
    const listed = await A((tx) =>
      listValueEvents(tx, wsA, {
        from: new Date("2026-10-19T00:00:00Z"),
        to: new Date("2026-10-26T00:00:00Z"),
      }),
    );
    expect(listed.find((e) => e.entityId === entity)).toMatchObject({ quantity: 45, occurredAt: now });
  });
});
