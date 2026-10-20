import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_USER } from "@meri/config";
import {
  bootstrapAccount,
  createCommitment,
  getEncryptedTokens,
  insertInferredEntries,
  insertNotification,
  softDeleteAccount,
  upsertCalendarEvent,
  isAccountActive,
  listAudit,
  listIntegrationAccounts,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import type { FakeGoogleOAuth } from "@meri/integrations";
import { createTestApp, csrf, INTERNAL_SECRET, NOW, type TestApp } from "../test/harness";
import { drainCapped } from "./account-export";

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
      entitlements: { maxClients: 25, aiCreditsMonthly: 300 },
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
    expect(doc).toMatchObject({ format: "meri-export/1", truncated: [], user: { email: a.email } });
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
        "activity", "billing", "blocks", "calendarEvents", "clients", "commitments", "connections", "contacts", "exportedAt",
        "format", "notifications", "preferences", "projects", "proposals", "tasks", "timeEntries", "truncated", "user",
        "workspace",
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
      payload: { email: c.email, subject: `dev:${c.email}` },
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

describe("account deletion revokes connections and protects the demo (D-049, D-054)", () => {
  it("revokes the Google token at the provider and wipes the stored ciphertext", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("revoke");
      const cookie = await t.cookieFor(acc);
      const start = await t.app.inject({ method: "POST", url: "/v1/integrations/google/connect", headers: { cookie, ...csrf } });
      const state = start.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
      const url = new URL(start.json<{ url: string }>().url);
      const cb = await t.app.inject({ url: `${url.pathname}${url.search}`, headers: { cookie: `${cookie}; meri.oauth.state=${state}` } });
      expect(cb.statusCode).toBe(302);
      const [account] = await withWorkspace(t.handle.db, acc.workspaceId, (tx) => listIntegrationAccounts(tx, acc.workspaceId));
      if (!account) throw new Error("no account");
      const oauth = t.integrations.oauth as FakeGoogleOAuth;
      const before = oauth.revoked.length;

      const del = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } });
      expect(del.statusCode).toBe(204);
      expect(oauth.revoked.length).toBe(before + 1);
      const row = await withWorkspace(t.handle.db, acc.workspaceId, (tx) => getEncryptedTokens(tx, acc.workspaceId, account.id));
      expect(row?.encryptedTokens).toBe("");
      const [after] = await withWorkspace(t.handle.db, acc.workspaceId, (tx) => listIntegrationAccounts(tx, acc.workspaceId));
      expect(after?.status).toBe("revoked");
    } finally {
      await t.close();
    }
  });

  it("refuses to delete the shared demo account under DEMO_MODE and leaves it intact", async () => {
    const t = await createTestApp({ env: { DEMO_MODE: "1" } });
    try {
      const demo = await bootstrapAccount(t.handle.db, { email: DEMO_USER.email, name: DEMO_USER.name, now: NOW });
      const cookie = await t.cookieFor(demo);
      const res = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(await isAccountActive(t.handle.db, demo.userId, demo.workspaceId)).toBe(true);
      // Any other account can still be deleted in DEMO_MODE.
      const other = await t.createAccount("demo-other");
      const otherCookie = await t.cookieFor(other);
      expect((await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie: otherCookie, ...csrf } })).statusCode).toBe(204);
    } finally {
      await t.close();
    }
  });
});

describe("export drainCapped (D-055)", () => {
  const pages = (total: number, size: number) => (cursor: string | undefined) => {
    const start = cursor ? Number(cursor) : 0;
    const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => start + i);
    const next = start + items.length;
    return Promise.resolve({ items, nextCursor: items.length === size && next <= total ? String(next) : null });
  };
  it("names a collection cut at the cap and returns exactly the cap", async () => {
    const truncated: string[] = [];
    const rows = await drainCapped("tasks", truncated, pages(25, 10), 20);
    expect(rows).toHaveLength(20);
    expect(truncated).toEqual(["tasks"]);
  });
  it("does not mark a collection that has exactly the cap, even when the last page is full", async () => {
    const truncated: string[] = [];
    const rows = await drainCapped("tasks", truncated, pages(20, 10), 20);
    expect(rows).toHaveLength(20);
    expect(truncated).toEqual([]);
  });
});

describe("export of a populated workspace (D-055)", () => {
  it("fills every collection from the user's data and carries no tokens, ciphertext or mail bodies", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("export-full");
      const cookie = await t.cookieFor(acc);
      const ws = acc.workspaceId;
      const post = (url: string, payload: Record<string, unknown>) =>
        t.app.inject({ method: "POST", url, headers: { cookie, ...csrf }, payload });
      // Google connected through the real (fake) OAuth flow: tokens are stored encrypted.
      const start = await post("/v1/integrations/google/connect", {});
      const state = start.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
      const url = new URL(start.json<{ url: string }>().url);
      await t.app.inject({ url: `${url.pathname}${url.search}`, headers: { cookie: `${cookie}; meri.oauth.state=${state}` } });
      const [account] = await withWorkspace(t.handle.db, ws, (tx) => listIntegrationAccounts(tx, ws));
      if (!account) throw new Error("no account");
      const cipher = (await withWorkspace(t.handle.db, ws, (tx) => getEncryptedTokens(tx, ws, account.id)))?.encryptedTokens ?? "";
      expect(cipher.length).toBeGreaterThan(20);

      const client = (await post("/v1/clients", { name: "Acme Corp", domains: ["acme.com"] })).json<{ id: string }>();
      const task = (await post("/v1/tasks", { title: "Informe para Acme", clientId: client.id, estimateMinutes: 60 })).json<{ id: string }>();
      expect((await post("/v1/capture", { text: "Llamar a Acme el jueves, 30 min" })).statusCode).toBeLessThan(300);
      expect((await post("/v1/plan/replan", {})).statusCode).toBe(200);
      const MAIL_BODY = "Cuerpo completo del correo que nunca debe exportarse";
      await withWorkspace(t.handle.db, ws, async (tx) => {
        await createCommitment(
          tx,
          ws,
          { clientId: client.id, direction: "owed_to_me", kind: "explicit", status: "confirmed", counterpartyEmail: "ana@acme.com", action: "Enviar el contrato", dueAt: NOW, dueText: null, confidence: 0.9, evidence: "te envío el contrato", threadId: null, externalMessageId: null, dedupeHash: "export-full:c1" },
          NOW,
        );
        const event = await upsertCalendarEvent(
          tx,
          ws,
          { integrationAccountId: account.id, externalId: "ev-1", etag: "1", title: "Llamada con Acme", startsAt: new Date(NOW.getTime() - 7_200_000), endsAt: new Date(NOW.getTime() - 3_600_000), allDay: false, attendees: ["ana@acme.com"], busy: true, origin: "external", clientId: client.id },
          NOW,
        );
        await insertInferredEntries(tx, ws, [{ sourceType: "calendar_event", sourceId: event.id, clientId: client.id, taskId: task.id, day: "2026-10-19", minutes: 60, description: "Llamada con Acme" }], NOW);
        await insertNotification(tx, ws, { kind: "digest", title: "Resumen", body: "Resumen del día", template: "daily_digest", params: {}, refs: [], day: "2026-10-19" }, NOW);
      });

      const doc = (await t.app.inject({ url: "/v1/account/export", headers: { cookie } })).json<Record<string, unknown[]>>();
      for (const k of ["clients", "tasks", "commitments", "proposals", "timeEntries", "calendarEvents", "blocks", "notifications", "activity", "connections"])
        expect(doc[k]?.length ?? 0, k).toBeGreaterThan(0);
      expect(Object.keys((doc.connections as Record<string, unknown>[])[0] ?? {}).sort()).toEqual(
        ["createdAt", "email", "lastSyncAt", "provider", "scopes", "status"],
      );
      const text = JSON.stringify(doc);
      expect(text).not.toContain(cipher.slice(0, 24));
      expect(text).not.toContain(MAIL_BODY);
      expect(text).toContain("te envío el contrato"); // the ≤ 200-char evidence the user already sees is theirs
      const suspicious = walkKeys(doc).filter((k) => /token|secret|encrypted|refresh|access|keyId|cursor|bodyText/i.test(k));
      expect(suspicious).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

function walkKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => walkKeys(v, found));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      found.push(k);
      walkKeys(v, found);
    }
  return found;
}

describe("deletion edge cases (D-054)", () => {
  it("still deletes and revokes the connection when the provider revocation fails", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("revoke-fails");
      const cookie = await t.cookieFor(acc);
      const start = await t.app.inject({ method: "POST", url: "/v1/integrations/google/connect", headers: { cookie, ...csrf } });
      const state = start.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
      const url = new URL(start.json<{ url: string }>().url);
      await t.app.inject({ url: `${url.pathname}${url.search}`, headers: { cookie: `${cookie}; meri.oauth.state=${state}` } });
      const oauth = t.integrations.oauth as FakeGoogleOAuth;
      const spy = vi.spyOn(oauth, "revoke").mockRejectedValueOnce(new Error("provider down"));
      const del = await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } });
      expect(del.statusCode).toBe(204);
      expect(spy).toHaveBeenCalledTimes(1);
      const [after] = await withWorkspace(t.handle.db, acc.workspaceId, (tx) => listIntegrationAccounts(tx, acc.workspaceId));
      expect(after?.status).toBe("revoked");
      spy.mockRestore();
    } finally {
      await t.close();
    }
  });

  it("softDeleteAccount is idempotent at the repository level and audits once", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("soft-twice");
      const first = await softDeleteAccount(t.handle.db, { userId: acc.userId, workspaceId: acc.workspaceId, now: NOW });
      const second = await softDeleteAccount(t.handle.db, { userId: acc.userId, workspaceId: acc.workspaceId, now: NOW });
      expect(first.deleted).toBe(true);
      expect(second).toEqual({ deleted: false, revokedAccounts: 0 });
      const page = await withWorkspace(t.handle.db, acc.workspaceId, (tx) => listAudit(tx, acc.workspaceId, 50));
      expect(page.items.filter((i) => i.action === "account.deleted")).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a member who is not the owner leaves without taking the workspace or its connections down", async () => {
    const t = await createTestApp();
    try {
      const owner = await t.createAccount("owner");
      const member = await t.createAccount("member");
      const result = await softDeleteAccount(t.handle.db, { userId: member.userId, workspaceId: owner.workspaceId, now: NOW });
      expect(result).toEqual({ deleted: true, revokedAccounts: 0 });
      expect(await isAccountActive(t.handle.db, owner.userId, owner.workspaceId)).toBe(true);
      const page = await withWorkspace(t.handle.db, owner.workspaceId, (tx) => listAudit(tx, owner.workspaceId, 5));
      expect(page.items[0]).toMatchObject({ action: "account.deleted", entityType: "user", entityId: member.userId });
    } finally {
      await t.close();
    }
  });

  it("a deletion made elsewhere (another API instance) is learnt from the database once the cache is reset", async () => {
    const t = await createTestApp();
    try {
      const acc = await t.createAccount("elsewhere");
      const cookie = await t.cookieFor(acc);
      expect((await t.app.inject({ url: "/v1/me", headers: { cookie } })).statusCode).toBe(200);
      await softDeleteAccount(t.handle.db, { userId: acc.userId, workspaceId: acc.workspaceId, now: NOW });
      t.app.accountGuard.reset(); // stands in for the 60 s TTL expiring
      expect((await t.app.inject({ url: "/v1/tasks", headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});
