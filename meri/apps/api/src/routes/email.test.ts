import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@meri/config/crypto";
import { ADMIN_WORKSPACE_CONTEXT, createDb, type DbHandle } from "@meri/db";
import { AUTH_SECRET, createTestApp, csrf, type TestApp } from "../test/harness";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

describe("email preference and one-click unsubscribe (D-114, D-116)", () => {
  let t: TestApp;
  let owner: DbHandle;
  beforeAll(async () => {
    t = await createTestApp();
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await t.close();
    await owner.close();
  });
  const prefOf = async (ws: string) =>
    (
      await owner.sql<{ email_notifications: string }[]>`
      select email_notifications from preferences where workspace_id = ${ws}`
    )[0]?.email_notifications;
  /** As a mail server does it (RFC 8058): form body, no cookie, no Origin, no CSRF header. */
  const oneClick = (token: string, remoteAddress = "10.8.0.1") =>
    t.app.inject({
      method: "POST",
      url: `/v1/email/unsubscribe?t=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
      remoteAddress,
    });

  it("defaults to the digest and is changed through /v1/preferences, validated", async () => {
    const acc = await t.createAccount("mail-pref");
    const cookie = await t.cookieFor(acc);
    const get = await t.app.inject({ url: "/v1/preferences", headers: { cookie } });
    expect(get.json<{ emailNotifications: string }>().emailNotifications).toBe("digest");
    const put = (value: unknown) =>
      t.app.inject({
        method: "PUT",
        url: "/v1/preferences",
        headers: { cookie, ...csrf },
        payload: { emailNotifications: value },
      });
    expect((await put("all")).statusCode).toBe(200);
    expect(await prefOf(acc.workspaceId)).toBe("all");
    expect((await put("weekly")).statusCode).toBe(400);
  });

  it("a mail server's one-click POST turns email off, is audited once and answers the same when repeated", async () => {
    const acc = await t.createAccount("mail-unsub");
    const token = signUnsubscribeToken(AUTH_SECRET, acc.workspaceId);
    const first = await oneClick(token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect(await prefOf(acc.workspaceId)).toBe("off");
    expect((await oneClick(token)).json()).toEqual({ ok: true });
    const audits = await owner.sql<{ actor: string; actor_user_id: string | null }[]>`
      select actor, actor_user_id from audit_log
      where workspace_id = ${acc.workspaceId} and action = 'notifications.email_unsubscribed'`;
    expect(audits).toEqual([{ actor: "user", actor_user_id: acc.userId }]);
  });

  it("the web page's JSON call works too, and a GET never unsubscribes", async () => {
    const acc = await t.createAccount("mail-page");
    const token = signUnsubscribeToken(AUTH_SECRET, acc.workspaceId);
    const get = await t.app.inject({ url: `/v1/email/unsubscribe?t=${encodeURIComponent(token)}` });
    expect(get.statusCode).not.toBe(200);
    expect(await prefOf(acc.workspaceId)).toBe("digest");
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/email/unsubscribe?t=${encodeURIComponent(token)}`,
      headers: { ...csrf, origin: "http://localhost:3000" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(await prefOf(acc.workspaceId)).toBe("off");
  });

  it("a forged, foreign-secret or tampered token changes nothing", async () => {
    const acc = await t.createAccount("mail-forged");
    const forged = [
      signUnsubscribeToken("another-secret-that-is-long-enough-000", acc.workspaceId),
      `${acc.workspaceId}.AAAA`,
      acc.workspaceId,
      `${signUnsubscribeToken(AUTH_SECRET, acc.workspaceId)}x`,
    ];
    for (const token of forged) {
      const res = await oneClick(token, "10.8.0.2");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(await prefOf(acc.workspaceId)).toBe("digest");
    expect((await t.app.inject({ method: "POST", url: "/v1/email/unsubscribe" })).statusCode).toBe(400);
  });

  it("one workspace's token never touches another workspace", async () => {
    const a = await t.createAccount("mail-a");
    const b = await t.createAccount("mail-b");
    await oneClick(signUnsubscribeToken(AUTH_SECRET, a.workspaceId), "10.8.0.3");
    expect(await prefOf(a.workspaceId)).toBe("off");
    expect(await prefOf(b.workspaceId)).toBe("digest");
  });
});
