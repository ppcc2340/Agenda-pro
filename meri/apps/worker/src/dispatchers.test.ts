import { createLogger } from "@meri/config";
import {
  ADMIN_WORKSPACE_CONTEXT,
  bootstrapAccount,
  createClient,
  createDb,
  ensureDevRoles,
  runMigrations,
  softDeleteAccount,
  updatePreferences,
  withWorkspace,
  type AccountIdentity,
  type DbHandle,
} from "@meri/db";
import { InMemoryDispatcher } from "@meri/jobs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchDailyReview, dispatchTimeInfer, type DispatcherDeps } from "./dispatchers";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
// Tuesday 10:40 in Madrid: past the default 09:00 work start, so the digest is due.
const NOW = new Date("2026-10-20T08:40:00Z");

describe("dispatchers skip logically deleted workspaces (D-054)", () => {
  let handle: DbHandle;
  let adminSql: postgres.Sql;
  let alive: AccountIdentity;
  let deleted: AccountIdentity;

  const onboardWithClient = async (label: string): Promise<AccountIdentity> => {
    const account = await bootstrapAccount(handle.db, {
      email: `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@test.local`,
      name: label,
      now: NOW,
    });
    await withWorkspace(handle.db, account.workspaceId, async (tx) => {
      await updatePreferences(tx, account.workspaceId, { timezone: "Europe/Madrid" }, { now: NOW, completeOnboarding: true });
      await createClient(tx, account.workspaceId, { name: `Cliente ${label}`, domains: [] }, NOW);
    });
    return account;
  };

  beforeAll(async () => {
    await runMigrations(TEST_ADMIN_URL);
    await ensureDevRoles(TEST_ADMIN_URL);
    handle = createDb(TEST_APP_URL, { max: 2 });
    adminSql = postgres(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
    alive = await onboardWithClient("alive");
    deleted = await onboardWithClient("deleted");
    await softDeleteAccount(handle.db, { userId: deleted.userId, workspaceId: deleted.workspaceId, now: NOW });
  });
  afterAll(async () => {
    await adminSql.end();
    await handle.close();
  });

  const run = async (fn: (deps: DispatcherDeps) => Promise<number>) => {
    const dispatcher = new InMemoryDispatcher();
    await fn({ adminSql, dispatcher, logger: createLogger({ name: "worker-test", level: "silent" }), now: () => NOW });
    return dispatcher.jobs.map((j) => (j.payload as { workspaceId: string }).workspaceId);
  };

  it("daily review and time inference reach the live workspace and never the deleted one", async () => {
    for (const fn of [dispatchDailyReview, dispatchTimeInfer]) {
      const workspaces = await run(fn);
      expect(workspaces, fn.name).toContain(alive.workspaceId);
      expect(workspaces, fn.name).not.toContain(deleted.workspaceId);
    }
  });
});
