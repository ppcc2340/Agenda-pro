import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAccountActive, listAudit, withWorkspace, type AccountIdentity } from "@meri/db";
import { createTestApp, csrf, INTERNAL_SECRET, type TestApp } from "../test/harness";

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
    const forged = await encode({
      token: { sub: a.userId, workspaceId: b.workspaceId, email: a.email },
      secret: "another-secret-another-secret-1234",
      salt: "authjs.session-token",
      maxAge: 60,
    });
    expect(
      (await t.app.inject({ url: "/v1/me", headers: { cookie: `authjs.session-token=${forged}` } }))
        .statusCode,
    ).toBe(401);
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
    const noHeader = await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieA },
      payload: { timezone: "Europe/Madrid" },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json()).toMatchObject({ code: "FORBIDDEN" });

    const invalid = await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieA, ...csrf },
      payload: { workStart: "25:00" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "workStart" }] });

    const ok = await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieA, ...csrf },
      payload: {
        timezone: "Europe/Madrid",
        workStart: "09:00",
        workEnd: "18:00",
        contingencyPct: 25,
        completeOnboarding: true,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      timezone: "Europe/Madrid",
      contingencyPct: 25,
      onboardedAt: "2026-10-19T10:40:00.000Z",
    });
    expect(
      (await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieA } })).json(),
    ).toMatchObject({ timezone: "Europe/Madrid" });
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: cookieA } })).json()).toMatchObject({
      onboarded: true,
    });

    const audit = await t.app.inject({ url: "/v1/audit?limit=10", headers: { cookie: cookieA } });
    expect(audit.statusCode).toBe(200);
    const items = audit.json<{
      items: { action: string; actor: string; before: { timezone: string }; after: { timezone: string } }[];
    }>().items;
    expect(items[0]).toMatchObject({
      action: "onboarding.completed",
      actor: "user",
      before: { timezone: "UTC" },
      after: { timezone: "Europe/Madrid" },
    });
  });

  it("isolates tenants: B never sees A's audit trail or preferences", async () => {
    await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieB, ...csrf },
      payload: { timezone: "America/Santiago" },
    });
    const auditB = await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieB } });
    const actionsB = auditB.json<{ items: { action: string; after: { timezone: string } }[] }>().items;
    expect(actionsB).toHaveLength(1);
    expect(actionsB[0]?.after.timezone).toBe("America/Santiago");
    expect(
      (await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieB } })).json(),
    ).toMatchObject({ timezone: "America/Santiago" });
    expect(
      (await t.app.inject({ url: "/v1/preferences", headers: { cookie: cookieA } })).json(),
    ).toMatchObject({ timezone: "Europe/Madrid" });
    const bad = await t.app.inject({ url: "/v1/audit?limit=0", headers: { cookie: cookieB } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("preferences merged validation", () => {
  it("rejects a lone workStart that is not before the stored workEnd", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("merge");
      const cookie = await t.cookieFor(acc);
      const res = await t.app.inject({
        method: "PUT",
        url: "/v1/preferences",
        headers: { cookie, ...csrf },
        payload: { workStart: "19:00" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "workEnd" }] });
      expect((await t.app.inject({ url: "/v1/preferences", headers: { cookie } })).json()).toMatchObject({
        workStart: "09:00",
      });
    } finally {
      await t.close();
    }
  });
});

describe("account export and deletion (D-050, D-054, D-055)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const walkKeys = (value: unknown, found: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v) => walkKeys(v, found));
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        found.push(k);
        walkKeys(v, found);
      }
    return found;
  };

  it("GET /v1/account/export returns an allow-listed JSON of the caller's data only, as an attachment", async () => {
    const a = await t.createAccount("export-a");
    const b = await t.createAccount("export-b");
    const cookieA = await t.cookieFor(a);
    const cookieB = await t.cookieFor(b);
    const post = (cookie: string, url: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url, headers: { cookie, ...csrf }, payload });
    expect((await post(cookieA, "/v1/clients", { name: "Acme Corp", domains: ["acme.com"] })).statusCode).toBe(201);
    expect((await post(cookieA, "/v1/tasks", { title: "Informe para Acme" })).statusCode).toBe(201);
    expect((await post(cookieB, "/v1/tasks", { title: "Secreto de Bob" })).statusCode).toBe(201);

    const res = await t.app.inject({ url: "/v1/account/export", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="meri-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const doc = res.json<Record<string, unknown>>();
    expect(doc).toMatchObject({ format: "meri-export/1", user: { email: a.email } });
    const text = JSON.stringify(doc);
    expect(text).toContain("Informe para Acme");
    expect(text).toContain("Acme Corp");
    expect(text).not.toContain("Secreto de Bob");
    expect(text).not.toContain(b.workspaceId);
    // Nothing from the integration layer: no token, key, cursor or secret-like key anywhere in the document.
    const suspicious = walkKeys(doc).filter((k) => /token|secret|encrypted|refresh|access|keyId|cursor/i.test(k));
    expect(suspicious).toEqual([]);
    expect(Object.keys(doc).sort()).toEqual(
      [
        "activity", "blocks", "calendarEvents", "clients", "commitments", "connections", "contacts", "exportedAt",
        "format", "notifications", "preferences", "projects", "proposals", "tasks", "timeEntries", "user", "workspace",
      ].sort(),
    );
    const activity = (await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieA } })).json<{
      items: { action: string }[];
    }>();
    expect(activity.items[0]?.action).toBe("account.exported");
    expect((await t.app.inject({ url: "/v1/account/export" })).statusCode).toBe(401);
  });

  it("PUT /v1/preferences { autonomy } is audited as preferences.autonomy_changed (control centre selector)", async () => {
    const e = await t.createAccount("autonomy-e");
    const cookie = await t.cookieFor(e);
    const res = await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie, ...csrf },
      payload: { autonomy: "auto_low_risk" },
    });
    expect(res.statusCode).toBe(200);
    const activity = (await t.app.inject({ url: "/v1/audit", headers: { cookie } })).json<{ items: { action: string }[] }>();
    expect(activity.items[0]?.action).toBe("preferences.autonomy_changed");
    // Same value again: a plain preferences update, not a change of autonomy.
    await t.app.inject({ method: "PUT", url: "/v1/preferences", headers: { cookie, ...csrf }, payload: { autonomy: "auto_low_risk" } });
    const again = (await t.app.inject({ url: "/v1/audit", headers: { cookie } })).json<{ items: { action: string }[] }>();
    expect(again.items[0]?.action).toBe("preferences.updated");
  });

  it("DELETE /v1/account needs CSRF, deletes logically, revokes connections, kills the session and refuses re-login", async () => {
    const c = await t.createAccount("delete-c");
    const d = await t.createAccount("delete-d");
    const cookieC = await t.cookieFor(c);
    const cookieD = await t.cookieFor(d);
    expect((await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie: cookieC } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: cookieC } })).statusCode).toBe(200);

    const del = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie: cookieC, ...csrf } });
    expect(del.statusCode).toBe(204);
    // The old cookie is dead for every route, not only /v1/me.
    for (const url of ["/v1/me", "/v1/tasks", "/v1/account/export", "/v1/audit"]) {
      const res = await t.app.inject({ url, headers: { cookie: cookieC } });
      expect(res.statusCode, url).toBe(401);
    }
    // Idempotent, and the other tenant is untouched.
    expect((await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie: cookieC, ...csrf } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: cookieD } })).statusCode).toBe(200);
    // Signing in again with the deleted email is refused until the purge job runs (D-054).
    const again = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers: { "x-internal-secret": INTERNAL_SECRET },
      payload: { email: c.email },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "CONFLICT" });
    // Audit row and logical deletion, read through the repositories (the session is gone).
    const page = await withWorkspace(t.handle.db, c.workspaceId, (tx) => listAudit(tx, c.workspaceId, 1));
    expect(page.items[0]?.action).toBe("account.deleted");
    expect(await isAccountActive(t.handle.db, c.userId, c.workspaceId)).toBe(false);
    expect(await isAccountActive(t.handle.db, d.userId, d.workspaceId)).toBe(true);
  });
});
