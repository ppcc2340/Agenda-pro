import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountIdentity } from "@meri/db";
import { createTestApp, csrf, type TestApp } from "../test/harness";

describe("account routes: session, preferences, audit and tenant isolation", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let b: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("alice");
    b = await t.createAccount("bob");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(b);
  });
  afterAll(() => t.close());

  it("rejects requests without a session, with a forged cookie, or with a session of a non-member", async () => {
    const none = await t.app.inject({ url: "/v1/me" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    const forged = await encode({ token: { sub: a.userId, workspaceId: b.workspaceId, email: a.email }, secret: "another-secret-another-secret-1234", salt: "authjs.session-token", maxAge: 60 });
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: `authjs.session-token=${forged}` } })).statusCode).toBe(401);
    // A valid cookie whose claims point to someone else's workspace must not grant access.
    const crossed = await t.cookieFor({ userId: a.userId, workspaceId: b.workspaceId, email: a.email });
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: crossed } })).statusCode).toBe(401);
  });

  it("GET /v1/me returns user, workspace, plan and entitlements", async () => {
    const res = await t.app.inject({ url: "/v1/me", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: a.userId, email: a.email, name: "alice" },
      workspace: { id: a.workspaceId },
      plan: { plan: "trial", status: "trialing", trialEndsAt: "2026-11-02T10:40:00.000Z" },
      entitlements: { maxClients: 10, aiCreditsMonthly: 300 },
      onboarded: false,
    });
  });

  it("PUT /v1/preferences requires the CSRF header, validates, audits and completes onboarding", async () => {
    const noHeader = await t.app.inject({ method: "PUT", url: "/v1/preferences", headers: { cookie: cookieA }, payload: { timezone: "Europe/Madrid" } });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json()).toMatchObject({ code: "FORBIDDEN" });

    const invalid = await t.app.inject({ method: "PUT", url: "/v1/preferences", headers: { cookie: cookieA, ...csrf }, payload: { workStart: "25:00" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "workStart" }] });

    const ok = await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieA, ...csrf },
      payload: { timezone: "Europe/Madrid", workStart: "09:00", workEnd: "18:00", contingencyPct: 25, completeOnboarding: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ timezone: "Europe/Madrid", contingencyPct: 25, onboardedAt: "2026-10-19T10:40:00.000Z" });
    expect((await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieA } })).json()).toMatchObject({ timezone: "Europe/Madrid" });
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: cookieA } })).json()).toMatchObject({ onboarded: true });

    const audit = await t.app.inject({ url: "/v1/audit?limit=10", headers: { cookie: cookieA } });
    expect(audit.statusCode).toBe(200);
    const items = audit.json<{ items: { action: string; actor: string; before: { timezone: string }; after: { timezone: string } }[] }>().items;
    expect(items[0]).toMatchObject({ action: "onboarding.completed", actor: "user", before: { timezone: "UTC" }, after: { timezone: "Europe/Madrid" } });
  });

  it("isolates tenants: B never sees A's audit trail or preferences", async () => {
    await t.app.inject({ method: "PUT", url: "/v1/preferences", headers: { cookie: cookieB, ...csrf }, payload: { timezone: "America/Santiago" } });
    const auditB = await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieB } });
    const actionsB = auditB.json<{ items: { action: string; after: { timezone: string } }[] }>().items;
    expect(actionsB).toHaveLength(1);
    expect(actionsB[0]?.after.timezone).toBe("America/Santiago");
    expect((await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieB } })).json()).toMatchObject({ timezone: "America/Santiago" });
    expect((await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieA } })).json()).toMatchObject({ timezone: "Europe/Madrid" });
    const bad = await t.app.inject({ url: "/v1/audit?limit=0", headers: { cookie: cookieB } });
    expect(bad.statusCode).toBe(400);
  });
});
