import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  listCalendarEvents,
  listIntegrationAccounts,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import {
  createIntegrations,
  IntegrationError,
  type FakeCalendar,
  type Integrations,
} from "@meri/integrations";
import { encryptTokens, syncCalendarAccount } from "./calendar-sync";
import type { HandlerDeps } from "./context";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");

describe("calendar.sync (F-04)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  let accountId: string;
  let integrations: Integrations;
  const email = "sync@meri.local";

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    });
    integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    deps = {
      db: handle.db,
      integrations,
      keys: integrations.kms.keys,
      logger: createLogger({ name: "jobs-test", level: "silent" }),
      now: () => NOW,
    };
    const acc = await bootstrapAccount(handle.db, {
      email: `cal-${Date.now().toString(36)}@test.local`,
      now: NOW,
    });
    ws = acc.workspaceId;
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW.toISOString(),
      scopes: [],
      externalAccountId: "sub",
      email,
    };
    accountId = await withWorkspace(handle.db, ws, async (tx) => {
      const pre = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email,
          scopes: [],
          encryptedTokens: "pending",
          keyId: "local",
        },
        NOW,
      );
      return pre.id;
    });
    const blob = await encryptTokens(deps, ws, accountId, tokens);
    await withWorkspace(handle.db, ws, (tx) =>
      upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email,
          scopes: [],
          encryptedTokens: blob,
          keyId: "local",
        },
        NOW,
      ),
    );
  });
  afterAll(() => handle.close());

  it("mirrors external and Meri events incrementally, idempotently, and handles cancellations and 410 resync", async () => {
    const cal = integrations.calendarFor(email) as FakeCalendar;
    cal.addExternalEvent({
      title: "Llamada semanal con Acme",
      startsAt: "2026-10-19T12:30:00Z",
      endsAt: "2026-10-19T13:15:00Z",
      attendees: ["ana@acme.com"],
    });
    const first = await syncCalendarAccount(deps, ws, accountId);
    expect(first).toMatchObject({ status: "synced", upserted: 1, removed: 0, fullResync: false });
    const again = await syncCalendarAccount(deps, ws, accountId);
    expect(again.upserted).toBe(0); // nothing changed since the cursor
    const meri = await cal.createMeriEvent(cal.meriCalendarId, {
      title: "Bloque",
      startsAt: "2026-10-19T14:00:00Z",
      endsAt: "2026-10-19T15:00:00Z",
    });
    const ext = cal.addExternalEvent({
      title: "Almuerzo",
      startsAt: "2026-10-19T15:30:00Z",
      endsAt: "2026-10-19T16:30:00Z",
    });
    expect((await syncCalendarAccount(deps, ws, accountId)).upserted).toBe(2);
    await cal.deleteMeriEvent(cal.meriCalendarId, meri.externalId);
    expect((await syncCalendarAccount(deps, ws, accountId)).removed).toBe(1);
    const events = await withWorkspace(handle.db, ws, (tx) =>
      listCalendarEvents(tx, ws, {
        from: new Date("2026-10-19T00:00:00Z"),
        to: new Date("2026-10-20T00:00:00Z"),
      }),
    );
    expect(events.map((e) => [e.title, e.origin])).toEqual([
      ["Llamada semanal con Acme", "external"],
      ["Almuerzo", "external"],
    ]);
    expect(events.every((e) => e.integrationAccountId === accountId)).toBe(true);

    // Full resync: corrupt the cursor so the provider demands a resync; the mirror is rebuilt, not duplicated.
    const { setSyncCursor } = await import("@meri/db");
    await withWorkspace(handle.db, ws, (tx) =>
      setSyncCursor(tx, ws, accountId, "calendar.events:primary", "not-a-number", NOW),
    );
    const resync = await syncCalendarAccount(deps, ws, accountId);
    expect(resync.fullResync).toBe(true);
    const after = await withWorkspace(handle.db, ws, (tx) =>
      listCalendarEvents(tx, ws, {
        from: new Date("2026-10-19T00:00:00Z"),
        to: new Date("2026-10-20T00:00:00Z"),
      }),
    );
    expect(after.map((e) => e.externalId).sort()).toEqual([ext.externalId, "ext-ev-1"].sort());
  });

  it("marks the account needs_reauth on AuthExpired without deleting mirrored data", async () => {
    const cal = integrations.calendarFor(email) as FakeCalendar;
    const original = cal.listCalendars.bind(cal);
    cal.listCalendars = () =>
      Promise.reject(new IntegrationError("AuthExpired", "google-calendar", "token revoked"));
    const res = await syncCalendarAccount(deps, ws, accountId);
    expect(res.status).toBe("needs_reauth");
    cal.listCalendars = original;
    const accounts = await withWorkspace(handle.db, ws, (tx) => listIntegrationAccounts(tx, ws));
    expect(accounts[0]).toMatchObject({ status: "needs_reauth", lastError: "AuthExpired" });
    const events = await withWorkspace(handle.db, ws, (tx) =>
      listCalendarEvents(tx, ws, {
        from: new Date("2026-10-19T00:00:00Z"),
        to: new Date("2026-10-20T00:00:00Z"),
      }),
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it("marks the account degraded on RateLimited (retryable, rethrown) and heals on the next successful sync", async () => {
    const cal = integrations.calendarFor(email) as FakeCalendar;
    const original = cal.listCalendars.bind(cal);
    cal.listCalendars = () => Promise.reject(new IntegrationError("RateLimited", "google-calendar", "429"));
    await expect(syncCalendarAccount(deps, ws, accountId)).rejects.toBeInstanceOf(IntegrationError);
    cal.listCalendars = original;
    let accounts = await withWorkspace(handle.db, ws, (tx) => listIntegrationAccounts(tx, ws));
    expect(accounts[0]).toMatchObject({ status: "degraded", lastError: "RateLimited" });
    const healed = await syncCalendarAccount(deps, ws, accountId);
    expect(healed.status).toBe("synced");
    accounts = await withWorkspace(handle.db, ws, (tx) => listIntegrationAccounts(tx, ws));
    expect(accounts[0]).toMatchObject({ status: "healthy", lastError: null });
  });
});
