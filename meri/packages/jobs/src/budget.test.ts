import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapAccount,
  createDb,
  entitlements,
  grantCreditPack,
  listNotifications,
  recordAiUsage,
  subscriptions,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { aiBudget, aiStatus, chargeAiUsage, notifyAiPaused } from "./budget";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T08:40:00Z");
const usage = { model: "fake", inputTokens: 10, outputTokens: 10, cachedTokens: 0, costMicroUsd: 1000 };
const opts = { now: NOW, aiMode: "fake" as const, costCapUsd: 6 };

describe("aiBudget / chargeAiUsage (D-061, [H3], [M6], [L13])", () => {
  let handle: DbHandle;
  const fresh = async (): Promise<WorkspaceId> =>
    (await bootstrapAccount(handle.db, { email: `bud-${crypto.randomUUID()}@test.local`, now: NOW }))
      .workspaceId;
  const inWs = <T>(ws: WorkspaceId, fn: Parameters<typeof withWorkspace<T>>[2]) =>
    withWorkspace(handle.db, ws, fn);

  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 2 });
  });
  afterAll(() => handle.close());

  it("allows within the trial allowance, also in fake AI mode, and charges once per operation unit", async () => {
    const ws = await fresh();
    const decision = await inWs(ws, (tx) => aiBudget(tx, ws, "extract_commitments", opts));
    expect(decision).toMatchObject({ allow: true, reason: null, cost: 1 });
    // Two model calls for one thread → one credit.
    const { charged } = await inWs(ws, (tx) =>
      chargeAiUsage(tx, ws, "extract_commitments", [usage, usage], { now: NOW }),
    );
    expect(charged).toBe(1);
    // The rules path made no call → nothing charged.
    expect(
      (await inWs(ws, (tx) => chargeAiUsage(tx, ws, "extract_commitments", [], { now: NOW }))).charged,
    ).toBe(0);
    const status = await inWs(ws, (tx) => aiStatus(tx, ws, opts));
    expect(status).toMatchObject({
      paused: false,
      reason: null,
      balance: { allowance: 300, used: 1, remaining: 299 },
    });
  });

  it("denies when the credits would not cover the operation; a pack restores the balance", async () => {
    const ws = await fresh();
    await inWs(ws, (tx) => recordAiUsage(tx, ws, { operation: "summary", ...usage, credits: 298 }, NOW));
    expect(await inWs(ws, (tx) => aiBudget(tx, ws, "followup_draft", opts))).toMatchObject({
      allow: false,
      reason: "credits_exhausted",
      cost: 3,
    });
    expect((await inWs(ws, (tx) => aiBudget(tx, ws, "extract_commitments", opts))).allow).toBe(true);
    await inWs(ws, (tx) =>
      grantCreditPack(
        tx,
        ws,
        { pack: "500", credits: 500, sourceEventId: `evt_${crypto.randomUUID()}` },
        NOW,
      ),
    );
    expect((await inWs(ws, (tx) => aiBudget(tx, ws, "followup_draft", opts))).allow).toBe(true);
  });

  it("crossing 80 % and 100 % leaves one billing notice each per period, outside the alert cap", async () => {
    const ws = await fresh();
    await inWs(ws, (tx) => recordAiUsage(tx, ws, { operation: "summary", ...usage, credits: 238 }, NOW));
    await inWs(ws, (tx) => chargeAiUsage(tx, ws, "followup_draft", [usage], { now: NOW })); // 241 ≥ 240
    await inWs(ws, (tx) => chargeAiUsage(tx, ws, "followup_draft", [usage], { now: NOW })); // no new threshold
    await inWs(ws, (tx) => recordAiUsage(tx, ws, { operation: "summary", ...usage, credits: 53 }, NOW));
    await inWs(ws, (tx) => chargeAiUsage(tx, ws, "followup_draft", [usage], { now: NOW })); // 300 ≥ 300
    await inWs(ws, (tx) => chargeAiUsage(tx, ws, "followup_draft", [usage], { now: NOW }));
    const notes = (await inWs(ws, (tx) => listNotifications(tx, ws, { limit: 20 }))).items;
    expect(notes.map((n) => n.template).sort()).toEqual(["credits.exhausted", "credits.warning"]);
    expect(notes.every((n) => n.kind === "billing")).toBe(true);
    const status = await inWs(ws, (tx) => aiStatus(tx, ws, opts));
    expect(status).toMatchObject({ paused: true, reason: "credits_exhausted" });
  });

  it("an ended trial without a card pauses AI (access), and the pause notice is sent once per period", async () => {
    const ws = await fresh();
    await inWs(ws, (tx) => tx.update(subscriptions).set({ trialEndsAt: new Date("2026-10-19T00:00:00Z") }));
    const d = await inWs(ws, (tx) => aiBudget(tx, ws, "capture_parse", opts));
    expect(d).toMatchObject({ allow: false, reason: "access_inactive" });
    await inWs(ws, (tx) => notifyAiPaused(tx, ws, "access_inactive", NOW));
    await inWs(ws, (tx) => notifyAiPaused(tx, ws, "access_inactive", NOW));
    await inWs(ws, (tx) => notifyAiPaused(tx, ws, "credits_exhausted", NOW)); // already covered by credits.exhausted
    const notes = (await inWs(ws, (tx) => listNotifications(tx, ws, { limit: 20 }))).items;
    expect(notes.map((n) => n.template)).toEqual(["ai.paused.access_inactive"]);
    expect((await inWs(ws, (tx) => aiStatus(tx, ws, opts))).reason).toBe("access_inactive");
  });

  it("Pro gets 20 AI briefings a month; Pro+ is unlimited ([L13])", async () => {
    const ws = await fresh();
    for (let i = 0; i < 20; i++)
      await inWs(ws, (tx) => recordAiUsage(tx, ws, { operation: "brief_client", ...usage, credits: 0 }, NOW));
    expect(await inWs(ws, (tx) => aiBudget(tx, ws, "brief_client", opts))).toMatchObject({
      allow: false,
      reason: "briefing_allowance",
    });
    await inWs(ws, (tx) => tx.update(entitlements).set({ features: ["briefings_unlimited"] }));
    expect((await inWs(ws, (tx) => aiBudget(tx, ws, "brief_client", opts))).allow).toBe(true);
  });

  it("the USD cost cap only applies to the live provider", async () => {
    const ws = await fresh();
    await inWs(ws, (tx) =>
      recordAiUsage(tx, ws, { operation: "summary", ...usage, costMicroUsd: 6_000_000, credits: 0 }, NOW),
    );
    expect((await inWs(ws, (tx) => aiBudget(tx, ws, "summary", opts))).allow).toBe(true);
    expect(await inWs(ws, (tx) => aiBudget(tx, ws, "summary", { ...opts, aiMode: "live" }))).toMatchObject({
      allow: false,
      reason: "cost_cap",
    });
    expect((await inWs(ws, (tx) => aiStatus(tx, ws, { ...opts, aiMode: "live" }))).reason).toBe("cost_cap");
  });
});
