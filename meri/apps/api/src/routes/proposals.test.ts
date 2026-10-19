import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProposalIfAbsent,
  entitlements,
  listAudit,
  upsertContact,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import { createTestApp, csrf, type TestApp } from "../test/harness";

describe("proposals: client_link and followup confirmation (D-040, F-08)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("proposals-a");
    cookie = await t.cookieFor(a);
  });
  afterAll(() => t.close());

  const propose = (kind: "client_link" | "followup", payload: Record<string, unknown>, hash: string) =>
    withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      createProposalIfAbsent(
        tx,
        a.workspaceId,
        { kind, payload, dedupeHash: hash, explanation: kind, sourceRef: null },
        new Date("2026-10-19T08:00:00Z"),
      ),
    );

  it("confirming a client_link creates the client (with edits), links its contacts and respects max_clients", async () => {
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      await upsertContact(tx, a.workspaceId, { email: "ana@acme.test" });
      await tx.update(entitlements).set({ maxClients: 1 });
    });
    const p = await propose(
      "client_link",
      { domain: "acme.test", suggestedName: "Acme", contacts: 1, threads: 2 },
      "client_link:acme.test",
    );
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${p?.id ?? ""}/confirm`,
      headers: { cookie, ...csrf },
      payload: { client: { name: "Acme S.L.", color: "#aa0000" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ task: null; commitment: null; client: { id: string; name: string; domains: string[] } }>();
    expect(body.client).toMatchObject({ name: "Acme S.L.", domains: ["acme.test"] });
    const contacts = await t.app.inject({ url: "/v1/contacts", headers: { cookie } });
    expect(contacts.json<{ items: { email: string; clientId: string | null }[] }>().items).toEqual([
      expect.objectContaining({ email: "ana@acme.test", clientId: body.client.id }),
    ]);
    const again = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${p?.id ?? ""}/confirm`,
      headers: { cookie, ...csrf },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    const second = await propose(
      "client_link",
      { domain: "globex.test", suggestedName: "Globex", contacts: 3, threads: 0 },
      "client_link:globex.test",
    );
    const blocked = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${second?.id ?? ""}/confirm`,
      headers: { cookie, ...csrf },
      payload: {},
    });
    expect(blocked.statusCode).toBe(402);
    // Batch confirmation never creates clients.
    const batch = await t.app.inject({
      method: "POST",
      url: "/v1/proposals/confirm-batch",
      headers: { cookie, ...csrf },
      payload: { ids: [second?.id ?? ""] },
    });
    expect(batch.json<{ skipped: { reason: string }[] }>().skipped[0]?.reason).toBe("low_confidence");
    const actions = (
      await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 20))
    ).items.map((e) => e.action);
    expect(actions).toContain("client.created");
  });

  it("confirming a followup proposal creates a waiting task and resolves it", async () => {
    const p = await propose(
      "followup",
      {
        kind: "unanswered_thread",
        commitmentId: null,
        threadId: null,
        subject: "Presupuesto",
        action: null,
        dueAt: null,
        counterpartyEmail: "luis@beta.test",
        counterpartyName: "Luis Mora",
        clientId: null,
        daysLate: 6,
        suggestedAction: "draft",
      },
      "followup:unanswered_thread:x",
    );
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${p?.id ?? ""}/confirm`,
      headers: { cookie, ...csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ task: { title: string; status: string } }>().task).toMatchObject({
      title: "Esperando a Luis Mora: Presupuesto",
      status: "waiting_on_third_party",
    });
    const pending = await t.app.inject({ url: "/v1/proposals?kind=followup", headers: { cookie } });
    expect(pending.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});
