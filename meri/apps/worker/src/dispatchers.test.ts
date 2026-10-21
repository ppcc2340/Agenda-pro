import { createLogger } from "@meri/config";
import {
  ADMIN_WORKSPACE_CONTEXT,
  bootstrapAccount,
  createClient,
  createCommitment,
  createDb,
  ensureDevRoles,
  runMigrations,
  softDeleteAccount,
  updatePreferences,
  upsertCalendarEvent,
  upsertContact,
  upsertIntegrationAccount,
  withWorkspace,
  type AccountIdentity,
  type DbHandle,
} from "@meri/db";
import { CALENDAR_SCOPES, GMAIL_SCOPES } from "@meri/integrations";
import { InMemoryDispatcher } from "@meri/jobs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dispatchAccountPurge,
  dispatchBriefingsPrepare,
  dispatchCalendarPolling,
  dispatchClientsScan,
  dispatchDailyClose,
  dispatchDailyReview,
  dispatchFollowupsScan,
  dispatchMailPolling,
  dispatchTimeInfer,
  dispatchUsageRollup,
  type DispatcherDeps,
} from "./dispatchers";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
// Tuesday 10:40 in Madrid: past the default 09:00 work start, so the digest is due.
const NOW = new Date("2026-10-20T08:40:00Z");

const DISPATCHERS = {
  dispatchCalendarPolling,
  dispatchMailPolling,
  dispatchDailyReview,
  dispatchFollowupsScan,
  dispatchClientsScan,
  dispatchBriefingsPrepare,
  dispatchTimeInfer,
  dispatchUsageRollup,
} as const;

describe("dispatchers skip logically deleted workspaces (D-054)", () => {
  let handle: DbHandle;
  let adminSql: postgres.Sql;
  let alive: AccountIdentity;
  let deleted: AccountIdentity;

  /** A workspace that every dispatcher would pick: Google account, unlinked contact, owed commitment, client meeting. */
  const prepared = async (label: string): Promise<AccountIdentity> => {
    const account = await bootstrapAccount(handle.db, {
      email: `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@test.local`,
      name: label,
      now: NOW,
    });
    const ws = account.workspaceId;
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid" }, { now: NOW, completeOnboarding: true });
      const client = await createClient(tx, ws, { name: `Cliente ${label}`, domains: [] }, NOW);
      const google = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: `sub-${label}-${ws}`,
          email: account.email,
          scopes: [...CALENDAR_SCOPES, ...GMAIL_SCOPES],
          encryptedTokens: "x",
          keyId: "local",
        },
        NOW,
      );
      await upsertContact(tx, ws, { email: `someone@${label}.example` });
      await createCommitment(
        tx,
        ws,
        {
          clientId: client.id,
          direction: "owed_to_me",
          kind: "explicit",
          status: "confirmed",
          counterpartyEmail: "a@b.example",
          action: "Enviar datos",
          dueAt: NOW,
          dueText: null,
          confidence: 0.9,
          evidence: null,
          threadId: null,
          externalMessageId: null,
          dedupeHash: `disp:${ws}`,
        },
        NOW,
      );
      const start = new Date(NOW.getTime() + 86_400_000);
      await upsertCalendarEvent(
        tx,
        ws,
        {
          integrationAccountId: google.id,
          externalId: `ev-${ws}`,
          etag: "1",
          title: "Reunión",
          startsAt: start,
          endsAt: new Date(start.getTime() + 3_600_000),
          allDay: false,
          attendees: [],
          busy: true,
          origin: "external",
          clientId: client.id,
        },
        NOW,
      );
    });
    return account;
  };

  beforeAll(async () => {
    await runMigrations(TEST_ADMIN_URL);
    await ensureDevRoles(TEST_ADMIN_URL);
    handle = createDb(TEST_APP_URL, { max: 2 });
    adminSql = postgres(TEST_ADMIN_URL, {
      max: 1,
      connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
    });
    alive = await prepared("alive");
    deleted = await prepared("deleted");
    await softDeleteAccount(handle.db, {
      userId: deleted.userId,
      workspaceId: deleted.workspaceId,
      now: NOW,
    });
    // The deletion revokes the connections; put them back to healthy so the polling tests prove the workspace
    // filter itself, not only the status filter.
    await adminSql`update integration_accounts set status = 'healthy' where workspace_id = ${deleted.workspaceId}`;
  });
  afterAll(async () => {
    await adminSql.end();
    await handle.close();
  });

  const run = async (fn: (deps: DispatcherDeps) => Promise<number>) => {
    const dispatcher = new InMemoryDispatcher();
    await fn({
      adminSql,
      dispatcher,
      logger: createLogger({ name: "worker-test", level: "silent" }),
      now: () => NOW,
      // A long-lived local test database keeps never-synced connections from earlier runs (and other suites run
      // in parallel): past the default batch they would crowd this run's accounts out. Never mutate their rows.
      pollBatch: 1_000_000,
    });
    return dispatcher.jobs.map((j) => (j.payload as { workspaceId: string }).workspaceId);
  };

  for (const [name, fn] of Object.entries(DISPATCHERS)) {
    it(`${name} reaches the live workspace and never the deleted one`, async () => {
      const workspaces = await run(fn);
      expect(workspaces).toContain(alive.workspaceId);
      expect(workspaces).not.toContain(deleted.workspaceId);
    });
  }

  it("dispatchAccountPurge only picks workspaces deleted more than 30 days ago (F-16, ADR 0007)", async () => {
    expect(await run(dispatchAccountPurge)).not.toContain(deleted.workspaceId);
    const old = await prepared("old-deleted");
    await softDeleteAccount(handle.db, { userId: old.userId, workspaceId: old.workspaceId, now: NOW });
    await adminSql`update workspaces set deleted_at = ${new Date(NOW.getTime() - 31 * 86_400_000)} where id = ${old.workspaceId}`;
    const picked = await run(dispatchAccountPurge);
    expect(picked).toContain(old.workspaceId);
    expect(picked).not.toContain(alive.workspaceId);
    expect(picked).not.toContain(deleted.workspaceId);
  });

  it("dispatchUsageRollup also closes the previous month during the first two days", async () => {
    const at = async (iso: string) => {
      const dispatcher = new InMemoryDispatcher();
      await dispatchUsageRollup({
        adminSql,
        dispatcher,
        logger: createLogger({ name: "worker-test", level: "silent" }),
        now: () => new Date(iso),
      });
      return dispatcher.jobs
        .filter((j) => (j.payload as { workspaceId: string }).workspaceId === alive.workspaceId)
        .map((j) => (j.payload as { period: string }).period)
        .sort();
    };
    expect(await at("2026-11-01T06:00:00Z")).toEqual(["2026-10", "2026-11"]);
    expect(await at("2026-11-15T06:00:00Z")).toEqual(["2026-11"]);
  });

  it("dispatchDailyClose fires after the local work end only, for live workspaces", async () => {
    const at = async (iso: string) => {
      const dispatcher = new InMemoryDispatcher();
      await dispatchDailyClose({
        adminSql,
        dispatcher,
        logger: createLogger({ name: "worker-test", level: "silent" }),
        now: () => new Date(iso),
      });
      return dispatcher.jobs.map((j) => (j.payload as { workspaceId: string }).workspaceId);
    };
    expect(await at("2026-10-20T08:40:00Z")).not.toContain(alive.workspaceId); // 10:40 in Madrid
    const evening = await at("2026-10-20T17:30:00Z"); // 19:30 in Madrid, past the default 18:00 end
    expect(evening).toContain(alive.workspaceId);
    expect(evening).not.toContain(deleted.workspaceId);
  });
});

describe("workspace scans are paginated, never capped (D-054 follow-up)", () => {
  it("eachPage walks every page by workspace id until a short page", async () => {
    const { eachPage, PAGE } = await import("./dispatchers");
    const ids = Array.from(
      { length: PAGE * 2 + 3 },
      (_, i) => `0192aaaa-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    const calls: string[] = [];
    const rows = await eachPage((after) => {
      calls.push(after);
      return Promise.resolve(
        ids
          .filter((id) => id > after)
          .slice(0, PAGE)
          .map((workspaceId) => ({ workspaceId })),
      );
    });
    expect(rows.map((r) => r.workspaceId)).toEqual(ids);
    expect(calls).toHaveLength(3);
  });

  it("eachPage refuses a page query that ignores the cursor instead of looping forever", async () => {
    const { eachPage, PAGE } = await import("./dispatchers");
    const full = Array.from({ length: PAGE }, (_, i) => ({
      workspaceId: `0192aaaa-0000-7000-8000-${String(i).padStart(12, "0")}`,
    }));
    await expect(eachPage(() => Promise.resolve(full))).rejects.toThrow(/order by workspace_id/);
  });
});
