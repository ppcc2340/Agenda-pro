import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryFlagStore } from "@meri/config";
import {
  entitlements,
  listNotifications,
  recordAiUsage,
  subscriptions,
  withWorkspace,
  type AccountIdentity,
  type WorkspaceId,
} from "@meri/db";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface Usage {
  paused: boolean;
  reason: string | null;
  credits: { allowance: number; used: number; remaining: number; ratio: number };
  access: { active: boolean; reason: string };
}

/**
 * F-15 AC1 / [H3] at the real call sites: with the credits used up (fake AI mode), capture and briefings answer by
 * rules without charging and with one notice; the planner and the rest of the app keep working. D-058: paused
 * access blocks new clients and paid features, never existing data.
 */
describe("AI credits at the call sites and access gating (F-15 AC1, [H3], D-058)", () => {
  let t: TestApp;
  const flags = new InMemoryFlagStore({ ai_capture: true, ai_briefings: true });
  const usage = async (cookie: string) =>
    (await t.app.inject({ url: "/v1/ai/usage", headers: { cookie } })).json<Usage>();
  const spend = (ws: WorkspaceId, credits: number) =>
    withWorkspace(t.handle.db, ws, (tx) =>
      recordAiUsage(
        tx,
        ws,
        {
          operation: "summary",
          model: "m",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costMicroUsd: 0,
          credits,
        },
        NOW,
      ),
    );
  const capture = (cookie: string, text: string) =>
    t.app.inject({ method: "POST", url: "/v1/capture", headers: { cookie, ...csrf }, payload: { text } });

  beforeAll(async () => {
    t = await createTestApp({ flags });
  });
  afterAll(() => t.close());

  it("with credits, AI capture runs and charges 0.2 credits", async () => {
    const a = await t.createAccount("cred-a");
    const cookie = await t.cookieFor(a);
    const res = await capture(cookie, "Llamar a Ana mañana");
    expect(res.statusCode).toBe(201);
    expect(res.json<{ payload: { source: string } }>().payload.source).toBe("ai");
    expect((await usage(cookie)).credits).toMatchObject({ allowance: 300, used: 0.2 });
  });

  it("credits used up: capture and briefing fall back to rules, nothing is charged, one notice, banner state", async () => {
    const b: AccountIdentity = await t.createAccount("cred-b");
    const cookie = await t.cookieFor(b);
    await spend(b.workspaceId, 300);
    const first = await capture(cookie, "Preparar informe para Acme el viernes");
    const second = await capture(cookie, "Revisar contrato");
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json<{ payload: { source: string } }>().payload.source).toBe("rules");
    const client = (
      await t.app.inject({
        method: "POST",
        url: "/v1/clients",
        headers: { cookie, ...csrf },
        payload: { name: "Acme" },
      })
    ).json<{ id: string }>();
    const briefing = await t.app.inject({
      method: "POST",
      url: `/v1/clients/${client.id}/briefing`,
      headers: { cookie, ...csrf },
      payload: {},
    });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.json<{ source: string }>().source).toBe("rules");
    const state = await usage(cookie);
    expect(state).toMatchObject({
      paused: true,
      reason: "credits_exhausted",
      credits: { used: 300, remaining: 0, ratio: 1 },
    });
    const notes = await withWorkspace(t.handle.db, b.workspaceId, (tx) =>
      listNotifications(tx, b.workspaceId, { limit: 20 }),
    );
    expect(notes.items.filter((n) => n.template === "credits.exhausted")).toHaveLength(1);
    // The planner keeps working.
    const replan = await t.app.inject({
      method: "POST",
      url: "/v1/plan/replan",
      headers: { cookie, ...csrf },
    });
    expect(replan.statusCode).toBe(200);
  });

  it("caps the reported ratio when there is no allowance", async () => {
    const c = await t.createAccount("cred-c");
    const cookie = await t.cookieFor(c);
    await withWorkspace(t.handle.db, c.workspaceId, (tx) =>
      tx.update(entitlements).set({ aiCreditsMonthly: 0 }),
    );
    await spend(c.workspaceId, 1);
    expect((await usage(cookie)).credits.ratio).toBe(10);
  });

  it("paused access: no new clients (402), no paid features, existing clients and data stay", async () => {
    const d = await t.createAccount("cred-d");
    const cookie = await t.cookieFor(d);
    const mk = (name: string) =>
      t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name } });
    expect((await mk("Antes")).statusCode).toBe(201);
    await withWorkspace(t.handle.db, d.workspaceId, async (tx) => {
      await tx.update(entitlements).set({ features: ["briefings_unlimited", "advanced_exports"] });
      await tx.update(subscriptions).set({ plan: "pro_plus", status: "canceled" });
    });
    const blocked = await mk("Después");
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json<{ code: string }>().code).toBe("ENTITLEMENT_REQUIRED");
    const exportRes = await t.app.inject({
      url: "/v1/time-entries/export.csv?month=2026-10",
      headers: { cookie },
    });
    expect(exportRes.statusCode).toBe(402);
    const list = await t.app.inject({ url: "/v1/clients", headers: { cookie } });
    expect(list.json<{ items: { name: string }[] }>().items.map((c) => c.name)).toEqual(["Antes"]);
    expect((await usage(cookie)).access).toMatchObject({ active: false, reason: "canceled" });
  });
});
