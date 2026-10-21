import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  getEncryptedTokens,
  getIntegrationAccount,
  setIntegrationStatus,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations, type FakeGoogleOAuth, type OAuthTokens } from "@meri/integrations";
import { googleAccess, markNeedsReauth, TokenRevokedError } from "./google-access";
import type { HandlerDeps } from "./handlers/context";
import { encryptTokens, readTokens } from "./tokens";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-21T09:00:00Z");

/** ADR 0008 (D-097): per-connection access, refresh with compare-and-swap, and the needs_reauth rule. */
describe("googleAccess", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let oauth: FakeGoogleOAuth;

  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 3 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    oauth = integrations.oauth as FakeGoogleOAuth;
    deps = {
      db: handle.db,
      integrations,
      keys: integrations.kms.keys,
      logger: createLogger({ name: "access-test", level: "silent" }),
      now: () => NOW,
    };
  });
  afterAll(() => handle.close());

  async function connect(expiresAt: Date, refreshToken: string | null = `rt-${Date.now().toString(36)}`) {
    const acc = await bootstrapAccount(handle.db, {
      email: `ga-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}@test.local`,
      now: NOW,
    });
    const ws = acc.workspaceId;
    const tokens: OAuthTokens = {
      accessToken: "old-access",
      refreshToken,
      expiresAt: expiresAt.toISOString(),
      scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
      externalAccountId: "sub-1",
      email: "ana@acme.test",
    };
    const accountId = await withWorkspace(handle.db, ws, async (tx) => {
      const row = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub-1",
          email: "ana@acme.test",
          scopes: tokens.scopes,
          encryptedTokens: "pending",
          keyId: "local",
        },
        NOW,
      );
      return row.id;
    });
    const blob = await encryptTokens(deps, ws, accountId, tokens);
    await withWorkspace(handle.db, ws, (tx) =>
      setIntegrationStatus(tx, ws, accountId, { encryptedTokens: blob }),
    );
    return { ws, accountId, refreshToken };
  }

  const stored = (ws: WorkspaceId, accountId: string) =>
    withWorkspace(handle.db, ws, (tx) => getEncryptedTokens(tx, ws, accountId));

  it("hands out a valid token without refreshing", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() + 3600_000));
    const before = oauth.refreshes;
    const ref = await googleAccess(deps, ws, accountId);
    expect(ref?.email).toBe("ana@acme.test");
    expect(await ref?.accessToken()).toBe("old-access");
    expect(oauth.refreshes).toBe(before);
  });

  it("refreshes an expiring token once for concurrent callers and stores it keeping identity and scopes", async () => {
    const { ws, accountId, refreshToken } = await connect(new Date(NOW.getTime() + 30_000));
    const ref = await googleAccess(deps, ws, accountId);
    const before = oauth.refreshes;
    const [a, b] = await Promise.all([ref?.accessToken(), ref?.accessToken()]);
    expect(a).toBe(b);
    expect(a).not.toBe("old-access");
    expect(oauth.refreshes).toBe(before + 1);
    const saved = await readTokens(deps, ws, accountId);
    expect(saved).toMatchObject({
      accessToken: a,
      refreshToken, // Google did not rotate it: the stored one is kept
      email: "ana@acme.test",
      externalAccountId: "sub-1",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
    });
    // A forced refresh (after a 401) renews even a valid token.
    expect(await ref?.accessToken({ forceRefresh: true })).not.toBe(a);
  });

  it("when another worker refreshed first, the swap fails and the stored token is used", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() - 1000));
    const ref = await googleAccess(deps, ws, accountId);
    // Meanwhile another process stored fresh tokens.
    const other = await encryptTokens(deps, ws, accountId, {
      accessToken: "from-other-worker",
      refreshToken: "rt-other",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      scopes: [],
      externalAccountId: "sub-1",
      email: "ana@acme.test",
    });
    await withWorkspace(handle.db, ws, (tx) =>
      setIntegrationStatus(tx, ws, accountId, { encryptedTokens: other }),
    );
    expect(await ref?.accessToken()).toBe("from-other-worker");
    expect((await stored(ws, accountId))?.encryptedTokens).toBe(other);
  });

  it("a revoked grant throws TokenRevokedError; needs_reauth only if the failing tokens are still stored", async () => {
    const { ws, accountId, refreshToken } = await connect(new Date(NOW.getTime() - 1000));
    await oauth.revoke(refreshToken ?? "");
    const ref = await googleAccess(deps, ws, accountId);
    const err = await ref?.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRevokedError);
    // The user reconnected before the failure was recorded: the new connection is not flagged.
    const reconnected = await encryptTokens(deps, ws, accountId, {
      accessToken: "new",
      refreshToken: "rt-new",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      scopes: [],
      externalAccountId: "sub-1",
      email: "ana@acme.test",
    });
    await withWorkspace(handle.db, ws, (tx) =>
      setIntegrationStatus(tx, ws, accountId, { encryptedTokens: reconnected }),
    );
    expect(
      await withWorkspace(handle.db, ws, (tx) =>
        markNeedsReauth(tx, ws, accountId, err as TokenRevokedError),
      ),
    ).toBe(false);
    expect(
      (await withWorkspace(handle.db, ws, (tx) => getIntegrationAccount(tx, ws, accountId)))?.status,
    ).toBe("healthy");
    // Without the reconnect it is flagged (and audited).
    const second = await connect(new Date(NOW.getTime() - 1000));
    await oauth.revoke(second.refreshToken ?? "");
    const ref2 = await googleAccess(deps, second.ws, second.accountId);
    const err2 = (await ref2?.accessToken().catch((e: unknown) => e)) as TokenRevokedError;
    expect(
      await withWorkspace(handle.db, second.ws, (tx) =>
        markNeedsReauth(tx, second.ws, second.accountId, err2),
      ),
    ).toBe(true);
    expect(
      (
        await withWorkspace(handle.db, second.ws, (tx) =>
          getIntegrationAccount(tx, second.ws, second.accountId),
        )
      )?.status,
    ).toBe("needs_reauth");
  });

  it("a connection without refresh token cannot be refreshed: it needs a reconnect", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() - 1000), null);
    const ref = await googleAccess(deps, ws, accountId);
    await expect(ref?.accessToken()).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it("remembers the Meri calendar of the connection", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() + 3600_000));
    const ref = await googleAccess(deps, ws, accountId);
    expect(ref?.meriCalendarId).toBeNull();
    await ref?.rememberMeriCalendar?.("meri-cal@group.calendar.google.com");
    expect((await googleAccess(deps, ws, accountId))?.meriCalendarId).toBe(
      "meri-cal@group.calendar.google.com",
    );
  });

  it("stores a rotated refresh token and new scopes when Google returns them (D-097)", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() - 1000));
    const spy = vi.spyOn(oauth, "refresh").mockResolvedValueOnce({
      accessToken: "rotated-access",
      refreshToken: "rt-rotated",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.app.created",
      ],
    });
    try {
      const ref = await googleAccess(deps, ws, accountId);
      expect(await ref?.accessToken()).toBe("rotated-access");
    } finally {
      spy.mockRestore();
    }
    expect(await readTokens(deps, ws, accountId)).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rt-rotated",
      scopes: expect.arrayContaining(["https://www.googleapis.com/auth/calendar.app.created"]) as unknown,
    });
  });

  it("two separate refs of one connection share a single refresh; a failed refresh frees the slot", async () => {
    const { ws, accountId } = await connect(new Date(NOW.getTime() - 1000));
    const [a, b] = await Promise.all([googleAccess(deps, ws, accountId), googleAccess(deps, ws, accountId)]);
    const before = oauth.refreshes;
    const [ta, tb] = await Promise.all([a?.accessToken(), b?.accessToken()]);
    expect(ta).toBe(tb);
    expect(oauth.refreshes).toBe(before + 1);
    // A transient failure rejects both callers and the next call tries again.
    const second = await connect(new Date(NOW.getTime() - 1000));
    const spy = vi.spyOn(oauth, "refresh").mockRejectedValueOnce(new Error("network down"));
    try {
      const [x, y] = await Promise.all([
        googleAccess(deps, second.ws, second.accountId),
        googleAccess(deps, second.ws, second.accountId),
      ]);
      const results = await Promise.allSettled([x?.accessToken(), y?.accessToken()]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    } finally {
      spy.mockRestore();
    }
    expect(await (await googleAccess(deps, second.ws, second.accountId))?.accessToken()).toBeTruthy();
  });
});
