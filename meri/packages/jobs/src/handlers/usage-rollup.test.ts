import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  getRollup,
  listNotifications,
  recordAiUsage,
  subscriptions,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { mailRetentionDays } from "./mail-purge";
import { runUsageRollup } from "./usage-rollup";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T08:40:00Z");

describe("billing.usage_rollup (D-062, [M10], [L12])", () => {
  let handle: DbHandle;
  let deps: HandlerDeps & { infraCostUsdPerUser: number };
  const warnings: unknown[] = [];
  const fresh = async (): Promise<WorkspaceId> =>
    (await bootstrapAccount(handle.db, { email: `roll-${crypto.randomUUID()}@test.local`, now: NOW }))
      .workspaceId;

  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 12).toString("base64"),
    });
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    const logger = createLogger({ name: "t", level: "silent" });
    const spy = Object.assign(Object.create(logger) as typeof logger, {
      warn: (obj: unknown) => {
        warnings.push(obj);
      },
    });
    deps = {
      db: handle.db,
      integrations,
      keys: integrations.kms.keys,
      logger: spy,
      now: () => NOW,
      infraCostUsdPerUser: 3,
    };
  });
  afterAll(() => handle.close());

  it("a trial has cost but no revenue: no margin percentage and no alarm", async () => {
    const ws = await fresh();
    await withWorkspace(handle.db, ws, (tx) =>
      recordAiUsage(
        tx,
        ws,
        {
          operation: "brief_client",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costMicroUsd: 250_000,
        },
        NOW,
      ),
    );
    const r = await runUsageRollup(deps, ws, "2026-10");
    expect(r).toMatchObject({ grossMarginPct: null, marginAlarm: false });
    const row = await withWorkspace(handle.db, ws, (tx) => getRollup(tx, ws, "2026-10"));
    expect(row).toMatchObject({
      plan: "trial",
      charged: false,
      creditsUsed: 5,
      aiCostMicroUsd: 250_000,
      revenueMicroUsd: 0,
      infraCostMicroUsd: 3_000_000,
    });
  });

  it("a paying Pro user is healthy; heavy AI cost raises the alarm (logged without personal data); re-runs upsert", async () => {
    const ws = await fresh();
    await withWorkspace(handle.db, ws, (tx) =>
      tx
        .update(subscriptions)
        .set({ plan: "pro", status: "active", priceInterval: "month", hasPaymentMethod: true }),
    );
    const healthy = await runUsageRollup(deps, ws, "2026-10");
    // 29 − 3 infra − (0.841 + 0.30) fee = 24.859 → 85.7 %
    expect(healthy).toMatchObject({ grossMarginPct: 85.7, marginAlarm: false });
    await withWorkspace(handle.db, ws, (tx) =>
      recordAiUsage(
        tx,
        ws,
        {
          operation: "extract_commitments",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costMicroUsd: 8_000_000,
        },
        NOW,
      ),
    );
    const alarm = await runUsageRollup(deps, ws, "2026-10");
    expect(alarm.marginAlarm).toBe(true);
    expect(warnings).toContainEqual({
      workspaceId: ws,
      period: "2026-10",
      grossMarginPct: alarm.grossMarginPct,
    });
    expect(await withWorkspace(handle.db, ws, (tx) => getRollup(tx, ws, "2026-10"))).toMatchObject({
      marginAlarm: true,
      aiCostMicroUsd: 8_000_000,
    });
  });

  it("yearly plans are spread per month from the catalogue", async () => {
    const ws = await fresh();
    await withWorkspace(handle.db, ws, (tx) =>
      tx
        .update(subscriptions)
        .set({ plan: "pro_plus", status: "active", priceInterval: "year", hasPaymentMethod: true }),
    );
    await runUsageRollup(deps, ws, "2026-10");
    expect((await withWorkspace(handle.db, ws, (tx) => getRollup(tx, ws, "2026-10")))?.revenueMicroUsd).toBe(
      41_000_000,
    );
  });

  it("a workspace in price cohort B is counted at anchor B (D-102), configurable", async () => {
    const ws = await fresh();
    await withWorkspace(handle.db, ws, (tx) =>
      tx
        .update(subscriptions)
        .set({ plan: "pro", status: "active", priceInterval: "month", hasPaymentMethod: true, priceCohort: "B" }),
    );
    await runUsageRollup(deps, ws, "2026-10");
    expect((await withWorkspace(handle.db, ws, (tx) => getRollup(tx, ws, "2026-10")))?.revenueMicroUsd).toBe(
      39_000_000,
    );
    await runUsageRollup({ ...deps, anchorB: { pro: 4500 } }, ws, "2026-10");
    expect((await withWorkspace(handle.db, ws, (tx) => getRollup(tx, ws, "2026-10")))?.revenueMicroUsd).toBe(
      45_000_000,
    );
  });

  it("trial.ending: once, only within 3 days of the end and only without a card ([M10])", async () => {
    const ws = await fresh();
    const notes = async () =>
      (await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 20 }))).items;
    expect((await runUsageRollup(deps, ws, "2026-10")).trialEndingNotified).toBe(false); // 14 days left
    await withWorkspace(handle.db, ws, (tx) =>
      tx.update(subscriptions).set({ trialEndsAt: new Date(NOW.getTime() + 2.5 * 86_400_000) }),
    );
    expect((await runUsageRollup(deps, ws, "2026-10")).trialEndingNotified).toBe(true);
    expect((await runUsageRollup(deps, ws, "2026-10")).trialEndingNotified).toBe(false);
    const sent = (await notes()).filter((n) => n.template === "trial.ending");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "billing", params: { days: 3 } });

    const carded = await fresh();
    await withWorkspace(handle.db, carded, (tx) =>
      tx
        .update(subscriptions)
        .set({ trialEndsAt: new Date(NOW.getTime() + 86_400_000), hasPaymentMethod: true }),
    );
    expect((await runUsageRollup(deps, carded, "2026-10")).trialEndingNotified).toBe(false);
  });
});

describe("mail retention under plan changes ([H2])", () => {
  it("applies the user's choice capped by the plan and the ceiling", () => {
    expect(mailRetentionDays({ preferenceDays: 30, accessActive: true, planDays: 90, maxDays: 365 })).toBe(
      30,
    );
    expect(mailRetentionDays({ preferenceDays: 365, accessActive: true, planDays: 90, maxDays: 365 })).toBe(
      90,
    );
    expect(mailRetentionDays({ preferenceDays: null, accessActive: true, planDays: 90, maxDays: 365 })).toBe(
      90,
    );
  });
  it("never shortens retention because access is paused: only the user's choice and the ceiling apply", () => {
    expect(mailRetentionDays({ preferenceDays: 365, accessActive: false, planDays: 90, maxDays: 365 })).toBe(
      365,
    );
    expect(mailRetentionDays({ preferenceDays: null, accessActive: false, planDays: 30, maxDays: 365 })).toBe(
      365,
    );
    expect(mailRetentionDays({ preferenceDays: 14, accessActive: false, planDays: 90, maxDays: 365 })).toBe(
      14,
    );
  });
  it("is at least one day", () => {
    expect(mailRetentionDays({ preferenceDays: 0, accessActive: true, planDays: 90, maxDays: 365 })).toBe(1);
  });
});
