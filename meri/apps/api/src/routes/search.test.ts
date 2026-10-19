import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommitment, createTask, withWorkspace, type AccountIdentity } from "@meri/db";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface Hit {
  type: string;
  id: string;
  title: string;
  clientId: string | null;
}

describe("GET /v1/search (F-09 AC2)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  let acme = "";
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("search-a");
    cookie = await t.cookieFor(a);
    acme = (await t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name: "Acme Contratos" } })).json<{ id: string }>().id;
    const beta = (await t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name: "Beta" } })).json<{ id: string }>().id;
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const base = { dueAt: null, kind: "shallow" as const, priority: 3, deadlineType: "soft" as const, estimateMinutes: 30, tags: [], origin: "user" as const };
      await createTask(tx, a.workspaceId, { ...base, title: "Revisar contrato marco", clientId: acme }, NOW);
      await createTask(tx, a.workspaceId, { ...base, title: "Contrato de Beta", clientId: beta }, NOW);
      await createTask(tx, a.workspaceId, { ...base, title: "100% _raro_", clientId: null }, NOW);
      await createCommitment(
        tx,
        a.workspaceId,
        { clientId: acme, direction: "owed_to_me", kind: "explicit", status: "confirmed", counterpartyEmail: null, action: "Enviar el contrato firmado", dueAt: null, dueText: null, confidence: 0.9, evidence: null, threadId: null, externalMessageId: null, dedupeHash: `s-${Date.now().toString(36)}` },
        NOW,
      );
    });
  });
  afterAll(() => t.close());

  it("finds tasks, commitments and clients by substring, scoped by client, with LIKE wildcards escaped", async () => {
    const all = (await t.app.inject({ url: "/v1/search?q=contrato", headers: { cookie } })).json<{ items: Hit[] }>().items;
    expect(all.map((h) => `${h.type}:${h.title}`).sort()).toEqual([
      "client:Acme Contratos",
      "commitment:Enviar el contrato firmado",
      "task:Contrato de Beta",
      "task:Revisar contrato marco",
    ]);
    const scoped = (await t.app.inject({ url: `/v1/search?q=contrato&clientId=${acme}`, headers: { cookie } })).json<{ items: Hit[] }>().items;
    expect(scoped.every((h) => h.clientId === acme && h.type !== "client")).toBe(true);
    expect(scoped).toHaveLength(2);
    expect((await t.app.inject({ url: "/v1/search?q=%25%20_raro", headers: { cookie } })).json<{ items: Hit[] }>().items.map((h) => h.title)).toEqual(["100% _raro_"]);
    expect((await t.app.inject({ url: "/v1/search?q=a", headers: { cookie } })).statusCode).toBe(400);
    const other = await t.cookieFor(await t.createAccount("search-b"));
    expect((await t.app.inject({ url: "/v1/search?q=contrato", headers: { cookie: other } })).json<{ items: Hit[] }>().items).toHaveLength(0);
  });
});
