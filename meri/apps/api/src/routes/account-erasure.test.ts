import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@meri/config";
import { ADMIN_WORKSPACE_CONTEXT, createDb, remainingPersonalRows, withWorkspace, type DbHandle } from "@meri/db";
import type { FakeBilling } from "@meri/integrations";
import { purgeDeletedAccount } from "@meri/jobs";
import { createTestApp, csrf, TEST_ADMIN_URL, type TestApp } from "../test/harness";

/**
 * F-16 AC1 (ADR 0007): an account built through the real routes (tasks, clients, capture, Google, a paid plan, a
 * cancellation survey) is deleted, purged by the `data.delete_account` handler after the window, and the
 * verification query finds no row left; the provider customer is erased too.
 */
describe("account erasure end to end", () => {
  let t: TestApp;
  let admin: DbHandle;
  beforeAll(async () => {
    t = await createTestApp();
    admin = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await admin.close();
    await t.close();
  });

  it("leaves no personal row in any table after the purge", async () => {
    const account = await t.createAccount("erase");
    const cookie = await t.cookieFor(account);
    const post = (url: string, payload?: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url, headers: { cookie, ...csrf, "idempotency-key": `k-${url}` }, payload });
    expect((await post("/v1/tasks", { title: "Preparar el informe", estimateMinutes: 60 })).statusCode).toBe(201);
    expect((await post("/v1/clients", { name: "Acme", domains: ["acme.com"] })).statusCode).toBe(201);
    expect((await post("/v1/capture", { text: "Llamar a Ana el viernes" })).statusCode).toBe(201);
    const connect = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: { cookie, ...csrf },
    });
    const state = connect.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
    const url = new URL(connect.json<{ url: string }>().url);
    await t.app.inject({ url: `${url.pathname}${url.search}`, headers: { cookie: `${cookie}; meri.oauth.state=${state}` } });
    const checkout = (await post("/v1/billing/checkout", { plan: "pro", interval: "month" })).json<{ url: string }>().url;
    const complete = new URL(checkout);
    await t.app.inject({ url: complete.pathname.replace(/^\/api/, "") + complete.search, headers: { cookie } });
    await post("/v1/billing/cancel", { reason: "price", comment: "Prueba de borrado" });
    const customer = await withWorkspace(t.handle.db, account.workspaceId, (tx) => tx.query.subscriptions.findFirst());
    expect(customer?.stripeCustomerId).toBeTruthy();

    const before = await remainingPersonalRows(admin.db, { workspaceId: account.workspaceId, userIds: [account.userId] });
    expect(Object.values(before).filter((n) => n > 0).length).toBeGreaterThan(8);

    expect((await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } })).statusCode).toBe(204);
    const deps = { db: t.handle.db, integrations: t.integrations, logger: createLogger({ name: "t", level: "silent" }) };
    // Within the window nothing is purged (the logical deletion can still be reviewed).
    expect(await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId)).toMatchObject({
      status: "not_eligible",
    });
    await admin.sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${account.workspaceId}`;
    const result = await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId);
    expect(result).toMatchObject({ status: "purged", customerDeleted: true });
    expect((t.integrations.billing as FakeBilling).deletedCustomers).toContain(customer?.stripeCustomerId);

    const after = await remainingPersonalRows(admin.db, { workspaceId: account.workspaceId, userIds: [account.userId] });
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    // Retrying the job is harmless.
    expect(await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId)).toMatchObject({
      status: "already_purged",
    });
  });
});
