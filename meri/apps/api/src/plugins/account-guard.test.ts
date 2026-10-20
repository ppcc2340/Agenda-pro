import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { softDeleteAccount } from "@meri/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_SECRET, createTestApp, NOW, type TestApp } from "../test/harness";
import { accountGuardPlugin } from "./account-guard";
import { sessionPlugin } from "./session";

/** A minimal app with only the session and the guard, so the TTL and the cache bound can be set per test. */
async function guardApp(t: TestApp, options: { ttlMs: number; maxEntries?: number }) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionPlugin, { secret: AUTH_SECRET, secure: false });
  await app.register(accountGuardPlugin, { db: t.handle.db, ...options });
  app.get("/who", (request) => ({ signedIn: request.session !== null }));
  await app.ready();
  return app;
}

describe("account guard (D-054)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const who = async (app: Awaited<ReturnType<typeof guardApp>>, cookieHeader: string) =>
    (await app.inject({ url: "/who", headers: { cookie: cookieHeader } })).json<{ signedIn: boolean }>().signedIn;

  it("with ttl 0 a deletion made elsewhere is seen on the very next request", async () => {
    const app = await guardApp(t, { ttlMs: 0 });
    const acc = await t.createAccount("guard-ttl0");
    const c = await t.cookieFor(acc);
    expect(await who(app, c)).toBe(true);
    await softDeleteAccount(t.handle.db, { userId: acc.userId, workspaceId: acc.workspaceId, now: NOW });
    expect(await who(app, c)).toBe(false);
    await app.close();
  });

  it("within the TTL the cached answer is reused, and markDeleted wins over it at once", async () => {
    const app = await guardApp(t, { ttlMs: 60_000 });
    const acc = await t.createAccount("guard-ttl");
    const c = await t.cookieFor(acc);
    expect(await who(app, c)).toBe(true);
    await softDeleteAccount(t.handle.db, { userId: acc.userId, workspaceId: acc.workspaceId, now: NOW });
    expect(await who(app, c)).toBe(true); // cached: the other instance's deletion is not seen yet
    app.accountGuard.markDeleted(acc.userId, acc.workspaceId);
    expect(await who(app, c)).toBe(false);
    app.accountGuard.reset();
    expect(await who(app, c)).toBe(false); // learnt from the database after the cache is gone
    await app.close();
  });

  it("evicts the least recently checked session beyond the bound, which is then re-read from the database", async () => {
    const app = await guardApp(t, { ttlMs: 60_000, maxEntries: 1 });
    const a = await t.createAccount("guard-evict-a");
    const b = await t.createAccount("guard-evict-b");
    const ca = await t.cookieFor(a);
    const cb = await t.cookieFor(b);
    expect(await who(app, ca)).toBe(true);
    await softDeleteAccount(t.handle.db, { userId: a.userId, workspaceId: a.workspaceId, now: NOW });
    expect(await who(app, cb)).toBe(true); // b's answer evicts a's
    expect(await who(app, ca)).toBe(false); // a is read again: deleted
    await app.close();
  });

  it("requests without a session are untouched", async () => {
    const app = await guardApp(t, { ttlMs: 0 });
    expect((await app.inject({ url: "/who" })).json()).toEqual({ signedIn: false });
    await app.close();
  });
});
