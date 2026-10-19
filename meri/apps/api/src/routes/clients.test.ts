import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendarEvents,
  contacts,
  entitlements,
  listAudit,
  newId,
  threadsIndex,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import { createTestApp, csrf, type TestApp } from "../test/harness";

interface ClientJson {
  id: string;
  name: string;
  domains: string[];
  color: string | null;
  followupsMuted: boolean;
  archivedAt: string | null;
  stats: { openCommitments: number; minutesApproved: number } | null;
}

describe("clients and matters (F-09, D-039)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("clients-a");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(await t.createAccount("clients-b"));
  });
  afterAll(() => t.close());

  const post = (payload: Record<string, unknown>, cookie = cookieA) =>
    t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload });

  it("creates, lists with stats, updates, archives and soft-deletes clients; validates domains and colours", async () => {
    const bad = await post({ name: "Acme", domains: ["not a domain"] });
    expect(bad.statusCode).toBe(400);
    expect((await post({ name: "Acme", color: "red" })).statusCode).toBe(400);
    const created = await post({
      name: "Acme Corp",
      domains: ["Acme.com"],
      color: "#1f6f8b",
      verticalTags: ["fiscal"],
    });
    expect(created.statusCode).toBe(201);
    const acme = created.json<ClientJson>();
    expect(acme.domains).toEqual(["acme.com"]);
    const list = await t.app.inject({ url: "/v1/clients?stats=true", headers: { cookie: cookieA } });
    const items = list.json<{ items: ClientJson[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.stats).toEqual({
      openCommitments: 0,
      overdueCommitments: 0,
      atRiskTasks: 0,
      minutesApproved: 0,
      minutesSuggested: 0,
    });
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/v1/clients/${acme.id}`,
      headers: { cookie: cookieA, ...csrf },
      payload: { name: "Acme Corporation", domains: ["acme.com", "acme.es"], notes: "Cliente desde 2024" },
    });
    expect(patched.json<ClientJson>()).toMatchObject({
      name: "Acme Corporation",
      domains: ["acme.com", "acme.es"],
    });
    const archived = await t.app.inject({
      method: "PATCH",
      url: `/v1/clients/${acme.id}`,
      headers: { cookie: cookieA, ...csrf },
      payload: { archived: true },
    });
    expect(archived.json<ClientJson>().archivedAt).not.toBeNull();
    expect(
      (await t.app.inject({ url: "/v1/clients", headers: { cookie: cookieA } })).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(0);
    expect(
      (await t.app.inject({ url: "/v1/clients?includeArchived=true", headers: { cookie: cookieA } })).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(1);
    await t.app.inject({
      method: "PATCH",
      url: `/v1/clients/${acme.id}`,
      headers: { cookie: cookieA, ...csrf },
      payload: { archived: false },
    });
    // Matters belong to the client; a foreign/unknown client is a validation error.
    const project = await t.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: cookieA, ...csrf },
      payload: { clientId: acme.id, name: "Contrato de servicios 2026", kind: "contrato" },
    });
    expect(project.statusCode).toBe(201);
    const unknown = await t.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: cookieA, ...csrf },
      payload: { clientId: "01a15596-f037-71e4-bfce-25b2f4a80b21", name: "x" },
    });
    expect(unknown.statusCode).toBe(400);
    const projects = await t.app.inject({
      url: `/v1/projects?clientId=${acme.id}`,
      headers: { cookie: cookieA },
    });
    expect(projects.json<{ items: { name: string }[] }>().items.map((p) => p.name)).toEqual([
      "Contrato de servicios 2026",
    ]);
    const del = await t.app.inject({
      method: "DELETE",
      url: `/v1/clients/${acme.id}`,
      headers: { cookie: cookieA, ...csrf },
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await t.app.inject({ url: `/v1/clients/${acme.id}`, headers: { cookie: cookieA } })).statusCode,
    ).toBe(404);
    // M5: a soft delete never detaches history (matters, time, threads keep their client_id).
    expect(
      (await t.app.inject({ url: `/v1/projects?clientId=${acme.id}`, headers: { cookie: cookieA } })).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(1);
    const page = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 50));
    const actions = page.items.map((e) => e.action);
    for (const expected of [
      "client.created",
      "client.updated",
      "client.archived",
      "client.restored",
      "project.created",
      "client.deleted",
    ])
      expect(actions).toContain(expected);
  });

  it("links unassigned contacts, threads and external events when a client's domains change (H1)", async () => {
    const accountId = "01a15596-f037-71e4-bfce-25b2f4a80b22";
    const other = await post({ name: "Globex", domains: ["globex.com"] });
    expect(other.statusCode).toBe(201);
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      await tx.insert(contacts).values([
        { id: newId(), workspaceId: a.workspaceId, email: "ana@initech.com" },
        { id: newId(), workspaceId: a.workspaceId, email: "bob@gmail.com" },
      ]);
      await tx.insert(threadsIndex).values([
        {
          id: newId(),
          workspaceId: a.workspaceId,
          integrationAccountId: accountId,
          externalThreadId: "t-initech",
          participants: ["me@test.local", "Ana@Initech.com"],
        },
        {
          id: newId(),
          workspaceId: a.workspaceId,
          integrationAccountId: accountId,
          externalThreadId: "t-mixed",
          participants: ["me@test.local", "ana@initech.com", "x@globex.com"],
        },
      ]);
      await tx.insert(calendarEvents).values([
        {
          id: newId(),
          workspaceId: a.workspaceId,
          integrationAccountId: accountId,
          externalId: "ev-initech",
          startsAt: new Date("2026-10-21T09:00:00Z"),
          endsAt: new Date("2026-10-21T10:00:00Z"),
          attendees: ["me@test.local", "ana@initech.com"],
        },
        {
          id: newId(),
          workspaceId: a.workspaceId,
          integrationAccountId: accountId,
          externalId: "ev-meri",
          startsAt: new Date("2026-10-21T11:00:00Z"),
          endsAt: new Date("2026-10-21T12:00:00Z"),
          attendees: ["ana@initech.com"],
          origin: "meri",
        },
      ]);
    });
    const initech = (await post({ name: "Initech", domains: ["initech.com"] })).json<ClientJson>();
    const linked = await withWorkspace(t.handle.db, a.workspaceId, async (tx) => ({
      contacts: (await tx.select({ e: contacts.email, c: contacts.clientId }).from(contacts))
        .filter((r) => r.c === initech.id)
        .map((r) => r.e),
      threads: (await tx.select({ x: threadsIndex.externalThreadId, c: threadsIndex.clientId }).from(threadsIndex))
        .filter((r) => r.c === initech.id)
        .map((r) => r.x),
      events: (await tx.select({ x: calendarEvents.externalId, c: calendarEvents.clientId }).from(calendarEvents))
        .filter((r) => r.c === initech.id)
        .map((r) => r.x),
    }));
    // The mixed thread (two clients) stays unassigned; Meri blocks are never linked; gmail.com is not a domain.
    expect(linked).toEqual({ contacts: ["ana@initech.com"], threads: ["t-initech"], events: ["ev-initech"] });
    // A domain already claimed by another client is ignored on PATCH.
    const steal = await t.app.inject({
      method: "PATCH",
      url: `/v1/clients/${initech.id}`,
      headers: { cookie: cookieA, ...csrf },
      payload: { domains: ["initech.com", "globex.com"] },
    });
    expect(steal.statusCode).toBe(200);
    const mixed = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      tx.select({ x: threadsIndex.externalThreadId, c: threadsIndex.clientId }).from(threadsIndex),
    );
    expect(mixed.find((r) => r.x === "t-mixed")?.c).toBeNull();
  });

  it("enforces the plan's max_clients (ENTITLEMENT_REQUIRED) and isolates tenants", async () => {
    const c = await t.createAccount("clients-c");
    const cookieC = await t.cookieFor(c);
    await withWorkspace(t.handle.db, c.workspaceId, (tx) => tx.update(entitlements).set({ maxClients: 2 }));
    const one = await post({ name: "Uno" }, cookieC);
    const two = await post({ name: "Dos" }, cookieC);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    const three = await post({ name: "Tres" }, cookieC);
    expect(three.statusCode).toBe(402);
    expect(three.json<{ code: string }>().code).toBe("ENTITLEMENT_REQUIRED");
    const id = one.json<ClientJson>().id;
    expect((await t.app.inject({ url: `/v1/clients/${id}`, headers: { cookie: cookieB } })).statusCode).toBe(
      404,
    );
    expect(
      (
        await t.app.inject({
          method: "PATCH",
          url: `/v1/clients/${id}`,
          headers: { cookie: cookieB, ...csrf },
          payload: { name: "Hack" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/clients/${id}`,
          headers: { cookie: cookieB, ...csrf },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ url: "/v1/clients", headers: { cookie: cookieB } })).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(0);
    // B cannot attach a matter to A's client.
    const foreign = await t.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: cookieB, ...csrf },
      payload: { clientId: id, name: "Ajeno" },
    });
    expect(foreign.statusCode).toBe(400);
  });
});
