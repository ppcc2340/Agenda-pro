import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NoopAnalytics } from "@meri/integrations";
import { INTERNAL_SECRET, createTestApp, csrf, type TestApp } from "../test/harness";

describe("analytics flow (D-065, [M9]): ids and enums only, after the fact", () => {
  let t: TestApp;
  let analytics: NoopAnalytics;
  const of = (ws: string, event: string) =>
    analytics.events.filter((e) => e.distinctId === ws && e.event === event);

  beforeAll(async () => {
    t = await createTestApp();
    analytics = t.integrations.analytics as NoopAnalytics;
  });
  afterAll(() => t.close());

  it("signup → capture → proposal shown once → dismissed; no content ever reaches analytics", async () => {
    const email = `flow-${Date.now().toString(36)}@test.local`;
    const boot = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: { email, name: "Laura Flores" },
    });
    expect(boot.statusCode).toBe(200);
    const account = boot.json<{ userId: string; workspaceId: string; email: string }>();
    const ws = account.workspaceId;
    expect(of(ws, "signup")).toHaveLength(1);
    expect(of(ws, "trial_started")[0]?.props).toEqual({ trialDays: 14 });
    // A second sign-in is not a signup.
    await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: { email },
    });
    expect(of(ws, "signup")).toHaveLength(1);

    const cookie = await t.cookieFor(account as Parameters<TestApp["cookieFor"]>[0]);
    const capture = await t.app.inject({
      method: "POST",
      url: "/v1/capture",
      headers: { cookie, ...csrf },
      payload: { text: "Llamar a Ana de Estudio Norte mañana" },
    });
    expect(capture.statusCode).toBe(201);
    expect(of(ws, "capture_created")[0]?.props).toEqual({ source: "rules" });
    const proposalId = capture.json<{ id: string }>().id;

    await t.app.inject({ url: "/v1/proposals", headers: { cookie } });
    await t.app.inject({ url: "/v1/proposals", headers: { cookie } });
    expect(of(ws, "proposal_shown")).toEqual([
      { event: "proposal_shown", distinctId: ws, props: { proposalId, kind: "capture" } },
    ]);
    const dismissed = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${proposalId}/dismiss`,
      headers: { cookie, ...csrf },
      payload: {},
    });
    expect(dismissed.statusCode).toBe(200);
    expect(of(ws, "proposal_dismissed")).toHaveLength(1);

    const everything = JSON.stringify(analytics.events);
    for (const secret of ["Estudio Norte", "Ana", "Laura Flores", email])
      expect(everything).not.toContain(secret);
    expect(analytics.errors).toEqual([]);
  });
});
