import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryFlagStore } from "@meri/config";
import { createCommitment, createTask, listAudit, upsertIntegrationAccount, upsertThread, withWorkspace, type AccountIdentity } from "@meri/db";
import type { FakeAiClient } from "@meri/integrations";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface BriefingJson {
  source: "rules" | "ai";
  reused: boolean;
  items: { claim: string; kind: string; sourceType: string; sourceId: string; url: string | null; sourceTitle: string | null }[];
}

describe("client briefing (F-11 AC1/AC2, F-09 AC1, D-043)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  let acme = "";
  let beta = "";
  const CANARY = "CANARIO-BETA-7731";

  beforeAll(async () => {
    t = await createTestApp({ flags: new InMemoryFlagStore({ ai_briefings: true }) });
    a = await t.createAccount("briefing-a");
    cookie = await t.cookieFor(a);
    const mk = (name: string, domains: string[]) =>
      t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name, domains } });
    acme = (await mk("Acme", ["acme.test"])).json<{ id: string }>().id;
    beta = (await mk("Beta", ["beta.test"])).json<{ id: string }>().id;
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const account = await upsertIntegrationAccount(
        tx,
        a.workspaceId,
        { provider: "google", externalAccountId: "sub", email: "yo@mifirma.test", scopes: [], encryptedTokens: "x", keyId: "local" },
        NOW,
      );
      await createTask(tx, a.workspaceId, { title: "Informe para Acme", clientId: acme, dueAt: "2026-10-21T10:00:00.000Z", kind: "deep", priority: 2, deadlineType: "hard", estimateMinutes: 120, tags: [], origin: "user" }, NOW);
      await createTask(tx, a.workspaceId, { title: `Plan secreto ${CANARY}`, clientId: beta, dueAt: null, kind: "shallow", priority: 3, deadlineType: "soft", estimateMinutes: 30, tags: [], origin: "user" }, NOW);
      await createTask(tx, a.workspaceId, { title: "Sin cliente, no debe salir", clientId: null, dueAt: null, kind: "shallow", priority: 3, deadlineType: "soft", estimateMinutes: 30, tags: [], origin: "user" }, NOW);
      await createCommitment(
        tx,
        a.workspaceId,
        { clientId: acme, direction: "owed_to_me", kind: "explicit", confidence: 0.95, status: "confirmed", action: "Enviar el contrato firmado", dueAt: new Date("2026-10-10T00:00:00Z"), dueText: null, counterpartyEmail: "ana@acme.test", threadId: null, evidence: null, dedupeHash: `brief-${Date.now().toString(36)}`, externalMessageId: null },
        NOW,
      );
      await upsertThread(tx, a.workspaceId, {
        integrationAccountId: account.id,
        externalThreadId: "th-acme-1",
        subject: "Propuesta de honorarios",
        participants: ["yo@mifirma.test", "ana@acme.test"],
        clientId: acme,
        lastMessageAt: new Date("2026-10-18T09:00:00Z"),
        lastMessageFromMe: true,
        lastExternalMessageId: "m-9",
      });
    });
  });
  afterAll(() => t.close());

  it("generates a fully traceable briefing, never shows client B to the model, and reuses it while unchanged", async () => {
    const ai = t.integrations.ai as FakeAiClient;
    const before = ai.calls.length;
    const res = await t.app.inject({ method: "POST", url: `/v1/clients/${acme}/briefing`, headers: { cookie, ...csrf }, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json<BriefingJson>();
    expect(body.reused).toBe(false);
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    // AC2: every claim traces to a source with a code-built link.
    for (const item of body.items) {
      expect(item.sourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.url).not.toBeNull();
      expect(item.sourceTitle).not.toBeNull();
    }
    expect(body.items.find((i) => i.sourceType === "thread")?.url).toBe("https://mail.google.com/mail/u/0/#all/th-acme-1");
    expect(body.items.map((i) => i.kind)).toContain("risk");
    // F-09 AC1: the payload the model saw contains nothing of Beta or of unassigned items.
    const calls = ai.calls.slice(before).filter((c) => c.operation === "brief_client");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).not.toContain(CANARY);
    expect(calls[0]?.user).not.toContain("Beta");
    expect(calls[0]?.user).not.toContain("Sin cliente");
    expect(calls[0]?.user).toContain("Informe para Acme");
    expect(JSON.stringify(body)).not.toContain(CANARY);
    // Cache: same context hash → reused, zero AI calls.
    const again = await t.app.inject({ method: "POST", url: `/v1/clients/${acme}/briefing`, headers: { cookie, ...csrf }, payload: {} });
    expect(again.json<BriefingJson>().reused).toBe(true);
    expect(ai.calls.length).toBe(before + 1);
    const get = await t.app.inject({ url: `/v1/clients/${acme}/briefing`, headers: { cookie } });
    expect(get.json<BriefingJson>().items).toEqual(body.items);
    // Changing the client's data invalidates the cache.
    await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      createTask(tx, a.workspaceId, { title: "Nueva tarea Acme", clientId: acme, dueAt: null, kind: "shallow", priority: 3, deadlineType: "soft", estimateMinutes: 15, tags: [], origin: "user" }, NOW),
    );
    const fresh = await t.app.inject({ method: "POST", url: `/v1/clients/${acme}/briefing`, headers: { cookie, ...csrf }, payload: {} });
    expect(fresh.json<BriefingJson>().reused).toBe(false);
    expect(ai.calls.length).toBe(before + 2);
    const actions = (await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 30))).items.map((e) => e.action);
    expect(actions.filter((x) => x === "briefing.generated")).toHaveLength(2);
    // Beta's briefing is Beta's only, and another tenant sees nothing.
    const b = await t.app.inject({ method: "POST", url: `/v1/clients/${beta}/briefing`, headers: { cookie, ...csrf }, payload: {} });
    expect(b.json<BriefingJson>().items.every((i) => i.claim.includes(CANARY))).toBe(true);
    const other = await t.cookieFor(await t.createAccount("briefing-b"));
    expect((await t.app.inject({ method: "POST", url: `/v1/clients/${acme}/briefing`, headers: { cookie: other, ...csrf }, payload: {} })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/v1/clients/${acme}/briefing`, headers: { cookie: other } })).statusCode).toBe(404);
  });
});
