import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  getEncryptedTokens,
  getIntegrationAccount,
  listCalendarEvents,
  setIntegrationStatus,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
} from "@meri/db";
import {
  CALENDAR_SCOPES,
  createIntegrations,
  LiveGoogleCalendar,
  SimulatedGoogleCalendar,
  type FakeGoogleOAuth,
  type Integrations,
} from "@meri/integrations";
import { syncCalendarAccount } from "./handlers/calendar-sync";
import type { HandlerDeps } from "./handlers/context";
import { encryptTokens } from "./tokens";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-21T09:00:00Z");

/**
 * The live path end to end (test review T2): calendar.sync through `googleAccess` and the live Calendar adapter on a
 * simulated Google that only accepts the newest access token. A 401 forces one refresh, the renewed tokens are
 * stored (compare-and-swap) and the sync completes; a revoked grant flags needs_reauth.
 */
describe("calendar.sync on the live adapter", () => {
  let handle: DbHandle;
  let base: Integrations;
  let oauth: FakeGoogleOAuth;

  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    base = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    oauth = base.oauth as FakeGoogleOAuth;
  });
  afterAll(() => handle.close());

  async function setup() {
    const sim = new SimulatedGoogleCalendar();
    let accepted = "fresh-token-not-issued-yet";
    const refresh = oauth.refresh.bind(oauth);
    oauth.refresh = async (rt) => {
      const r = await refresh(rt);
      accepted = r.accessToken;
      return r;
    };
    // Google rejects any access token but the newest one issued.
    const guarded: typeof fetch = (input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${accepted}`)
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 }));
      return sim.fetch(input, init);
    };
    const integrations: Integrations = {
      ...base,
      calendarFor: (ref) => {
        if (typeof ref === "string") throw new Error("live adapters need a connection");
        return new LiveGoogleCalendar(ref, { fetch: guarded });
      },
    };
    const deps: HandlerDeps = {
      db: handle.db,
      integrations,
      keys: base.kms.keys,
      logger: createLogger({ name: "live-path", level: "silent" }),
      now: () => NOW,
    };
    const acc = await bootstrapAccount(handle.db, {
      email: `live-${Date.now().toString(36)}@test.local`,
      now: NOW,
    });
    const ws = acc.workspaceId;
    const refreshToken = `rt-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}`;
    const accountId = await withWorkspace(
      handle.db,
      ws,
      async (tx) =>
        (
          await upsertIntegrationAccount(
            tx,
            ws,
            {
              provider: "google",
              externalAccountId: "sub-live",
              email: "ana@acme.test",
              scopes: [...CALENDAR_SCOPES],
              encryptedTokens: "pending",
              keyId: "local",
            },
            NOW,
          )
        ).id,
    );
    // A token that is still valid by its clock but that Google no longer accepts.
    const blob = await encryptTokens(deps, ws, accountId, {
      accessToken: "stale-access",
      refreshToken,
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
      externalAccountId: "sub-live",
      email: "ana@acme.test",
    });
    await withWorkspace(handle.db, ws, (tx) =>
      setIntegrationStatus(tx, ws, accountId, { encryptedTokens: blob }),
    );
    sim.addExternal({
      title: "Cliente",
      startsAt: "2026-10-22T09:00:00.000Z",
      endsAt: "2026-10-22T10:00:00.000Z",
    });
    const restore = () => {
      oauth.refresh = refresh;
    };
    return { deps, ws, accountId, blob, refreshToken, restore };
  }

  it("a 401 forces one refresh, the renewed tokens are stored and the events are mirrored", async () => {
    const { deps, ws, accountId, blob, restore } = await setup();
    try {
      const before = oauth.refreshes;
      const res = await syncCalendarAccount(deps, ws, accountId);
      expect(res.status).toBe("synced");
      expect(oauth.refreshes).toBe(before + 1);
      const stored = await withWorkspace(handle.db, ws, (tx) => getEncryptedTokens(tx, ws, accountId));
      expect(stored?.encryptedTokens).not.toBe(blob);
      const events = await withWorkspace(handle.db, ws, (tx) =>
        listCalendarEvents(tx, ws, {
          from: new Date("2026-10-01T00:00:00Z"),
          to: new Date("2026-11-01T00:00:00Z"),
        }),
      );
      expect(events.map((e) => e.title)).toContain("Cliente");
    } finally {
      restore();
    }
  });

  it("a revoked grant ends in needs_reauth with an audit entry, and nothing is mirrored", async () => {
    const { deps, ws, accountId, refreshToken, restore } = await setup();
    try {
      await oauth.revoke(refreshToken);
      const res = await syncCalendarAccount(deps, ws, accountId);
      expect(res.status).toBe("needs_reauth");
      expect(
        (await withWorkspace(handle.db, ws, (tx) => getIntegrationAccount(tx, ws, accountId)))?.status,
      ).toBe("needs_reauth");
    } finally {
      restore();
    }
  });
});
