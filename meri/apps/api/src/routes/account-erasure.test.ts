import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@meri/config";
import {
  ADMIN_WORKSPACE_CONTEXT,
  createDb,
  remainingPersonalRows,
  withWorkspace,
  workspaceDeletedAt,
  type DbHandle,
} from "@meri/db";
import type { FakeBilling } from "@meri/integrations";
import { purgeDeletedAccount } from "@meri/jobs";
import { makeFixtures } from "../test/authz-fixtures";
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
    // The authorization fixtures fill most tables (clients, projects, tasks, commitments, proposals, events, time,
    // blocks, notifications, contacts, exclusions, Google connection); the steps below add the rest.
    const fx = await makeFixtures(t, "erase");
    const { account, cookie } = fx;
    const post = (url: string, payload?: Record<string, unknown>) =>
      t.app.inject({
        method: "POST",
        url,
        headers: { cookie, ...csrf, "idempotency-key": `k-${url}` },
        payload,
      });
    expect((await post("/v1/tasks", { title: "Preparar el informe", estimateMinutes: 60 })).statusCode).toBe(
      201,
    );
    expect((await post("/v1/clients", { name: "Acme", domains: ["acme.com"] })).statusCode).toBe(201);
    expect((await post("/v1/capture", { text: "Llamar a Ana el viernes" })).statusCode).toBe(201);
    const connect = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: { cookie, ...csrf },
    });
    const state = connect.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
    const url = new URL(connect.json<{ url: string }>().url);
    await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookie}; meri.oauth.state=${state}` },
    });
    const checkout = (await post("/v1/billing/checkout", { plan: "pro", interval: "month" })).json<{
      url: string;
    }>().url;
    const complete = new URL(checkout);
    await t.app.inject({
      url: complete.pathname.replace(/^\/api/, "") + complete.search,
      headers: { cookie },
    });
    await post("/v1/billing/cancel", { reason: "price", comment: "Prueba de borrado" });
    const customer = await withWorkspace(t.handle.db, account.workspaceId, (tx) =>
      tx.query.subscriptions.findFirst(),
    );
    expect(customer?.stripeCustomerId).toBeTruthy();

    await t.app.inject({
      method: "PUT",
      url: `/v1/tasks/${fx.otherTask}/dependencies`,
      headers: { cookie, ...csrf },
      payload: { blockedBy: [fx.task] },
    });
    await post(`/v1/clients/${fx.client}/briefing`, {});
    await post("/v1/plan/replan");
    // Tables only written by workers or live providers (usage, rollups, credit packs, Gmail index, sync cursors,
    // value events): one row each, as the owner, so every classified table is non-empty before the purge.
    const ws = account.workspaceId;
    await admin.sql.begin(async (tx) => {
      // The admin read context is read-only under RLS: write inside this workspace's own context.
      await tx`select set_config('app.workspace_id', ${ws}, true)`;
      await tx`insert into feature_flags (id, key, workspace_id, enabled) values (gen_random_uuid(), 'erasure-test', ${ws}, true)`;
      await tx`insert into ai_usage (id, workspace_id, operation, model, period) values (gen_random_uuid(), ${ws}, 'briefing', 'fake', '2026-10')`;
      await tx`insert into billing_rollups (id, workspace_id, period, plan, charged, computed_at) values (gen_random_uuid(), ${ws}, '2026-10', 'pro', false, now())`;
      await tx`insert into credit_grants (id, workspace_id, credits, period, pack, source_event_id) values (gen_random_uuid(), ${ws}, 500, '2026-10', '500', ${`evt_${ws}`})`;
      await tx`insert into sync_state (workspace_id, integration_account_id, resource) values (${ws}, ${fx.integration}, 'gmail.history')`;
      await tx`insert into threads_index (id, workspace_id, integration_account_id, external_thread_id) values (gen_random_uuid(), ${ws}, ${fx.integration}, 'erase-thread')`;
      await tx`insert into value_events (id, workspace_id, type, method) values (gen_random_uuid(), ${ws}, 'commitment_fulfilled_on_time', 'explicit')`;
    });
    const before = await remainingPersonalRows(admin.db, {
      workspaceId: account.workspaceId,
      userIds: [account.userId],
    });
    // Every classified table holds a row of this account, so «0 after the purge» proves the erasure for each one.
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);

    expect(
      (await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } })).statusCode,
    ).toBe(204);
    const deps = {
      db: t.handle.db,
      integrations: t.integrations,
      logger: createLogger({ name: "t", level: "silent" }),
    };
    // Within the window nothing is purged (the logical deletion can still be reviewed).
    expect(await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId)).toMatchObject({
      status: "not_eligible",
    });
    await admin.sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${account.workspaceId}`;
    const result = await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId);
    expect(result).toMatchObject({ status: "purged", customerDeleted: true });
    expect((t.integrations.billing as FakeBilling).deletedCustomers).toContain(customer?.stripeCustomerId);

    const after = await remainingPersonalRows(admin.db, {
      workspaceId: account.workspaceId,
      userIds: [account.userId],
    });
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    // Retrying the job is harmless.
    expect(await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId)).toMatchObject({
      status: "already_purged",
    });
  });

  it("a provider failure leaves the workspace in place and a retry erases both (customer first, then rows)", async () => {
    const account = await t.createAccount("erase-retry");
    const cookie = await t.cookieFor(account);
    const post = (url: string, payload?: Record<string, unknown>) =>
      t.app.inject({
        method: "POST",
        url,
        headers: { cookie, ...csrf, "idempotency-key": `r-${url}` },
        payload,
      });
    const checkout = (await post("/v1/billing/checkout", { plan: "pro", interval: "month" })).json<{
      url: string;
    }>().url;
    const complete = new URL(checkout);
    await t.app.inject({
      url: complete.pathname.replace(/^\/api/, "") + complete.search,
      headers: { cookie },
    });
    const customer = (
      await withWorkspace(t.handle.db, account.workspaceId, (tx) => tx.query.subscriptions.findFirst())
    )?.stripeCustomerId;
    expect(customer).toBeTruthy();
    expect(
      (await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } })).statusCode,
    ).toBe(204);
    await admin.sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${account.workspaceId}`;
    const deps = {
      db: t.handle.db,
      integrations: t.integrations,
      logger: createLogger({ name: "t", level: "silent" }),
    };
    const billing = t.integrations.billing as FakeBilling;
    const original = billing.deleteCustomer.bind(billing);
    billing.deleteCustomer = () => Promise.reject(new Error("provider unavailable"));
    try {
      await expect(
        purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId),
      ).rejects.toThrow(/provider unavailable/);
    } finally {
      billing.deleteCustomer = original;
    }
    // Nothing was purged: the customer id is still there for the retry.
    expect(await workspaceDeletedAt(t.handle.db, account.workspaceId)).toBeInstanceOf(Date);
    expect(await purgeDeletedAccount({ ...deps, now: () => new Date() }, account.workspaceId)).toMatchObject({
      status: "purged",
      customerDeleted: true,
    });
    expect(billing.deletedCustomers).toContain(customer);
  });
});
