import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, csrf, type TestApp } from "../test/harness";

/** ADR 0007: «sign out on all devices» compares the sign-in instant, which survives every JWT re-issue. */
describe("POST /v1/account/sessions/revoke and the session lifetime", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  const me = (cookie: string) => t.app.inject({ url: "/v1/me", headers: { cookie } });

  it("revokes every session authenticated before now, even one re-issued afterwards, and only for that user", async () => {
    const a = await t.createAccount("sess-a");
    const b = await t.createAccount("sess-b");
    const signedIn = Date.now() - 60_000;
    const cookieA = await t.cookieFor(a, { authTime: signedIn });
    const cookieB = await t.cookieFor(b, { authTime: signedIn });
    expect((await me(cookieA)).statusCode).toBe(200);

    const noCsrf = await t.app.inject({ method: "POST", url: "/v1/account/sessions/revoke", headers: { cookie: cookieA } });
    expect(noCsrf.statusCode).toBe(403);
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/account/sessions/revoke",
      headers: { cookie: cookieA, ...csrf },
    });
    expect(res.statusCode).toBe(204);

    expect((await me(cookieA)).statusCode).toBe(401);
    // Auth.js re-encodes the token on every read with a fresh iat: the sign-in instant is what counts.
    const reissued = await t.cookieFor(a, { authTime: signedIn, iat: Math.floor(Date.now() / 1000) + 5 });
    expect((await me(reissued)).statusCode).toBe(401);
    // Learnt from the database by another instance (cache cleared), not only from this process.
    t.app.accountGuard.reset();
    expect((await me(cookieA)).statusCode).toBe(401);
    // A new sign-in works; the other user is untouched.
    expect((await me(await t.cookieFor(a, { authTime: Date.now() + 1000 }))).statusCode).toBe(200);
    expect((await me(cookieB)).statusCode).toBe(200);

    const audits = await t.app.inject({
      url: "/v1/audit?limit=20",
      headers: { cookie: await t.cookieFor(a, { authTime: Date.now() + 1000 }) },
    });
    expect(audits.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toContain(
      "account.sessions_revoked",
    );
  });

  it("refuses a token without a sign-in instant and one older than the absolute 14-day lifetime", async () => {
    const c = await t.createAccount("sess-c");
    expect((await me(await t.cookieFor(c, { authTime: undefined }))).statusCode).toBe(401);
    const old = Date.now() - 15 * 24 * 3600 * 1000;
    expect((await me(await t.cookieFor(c, { authTime: old }))).statusCode).toBe(401);
    expect((await me(await t.cookieFor(c, { authTime: Date.now() - 13 * 24 * 3600 * 1000 }))).statusCode).toBe(200);
  });
});
