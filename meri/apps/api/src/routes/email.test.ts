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
    const audits = await owner.sql<
      { actor: string; actor_user_id: string | null; before: unknown; after: unknown }[]
    >`
      select actor, actor_user_id, before, after from audit_log
      where workspace_id = ${acc.workspaceId} and action = 'notifications.email_unsubscribed'`;
    // Whoever holds the link may act (a mail server, a forwarded email): attributed to the system, not the owner.
    expect(audits).toEqual([
      {
        actor: "system",
        actor_user_id: null,
        before: { emailNotifications: "digest" },
        after: { emailNotifications: "off", via: "signed_link" },
      },
    ]);
  });

  it("the web page's JSON call works too, and a GET never unsubscribes", async () => {
    const acc = await t.createAccount("mail-page");
    const token = signUnsubscribeToken(AUTH_SECRET, acc.workspaceId);
    const get = await t.app.inject({ url: `/v1/email/unsubscribe?t=${encodeURIComponent(token)}` });
    // Mail clients without one-click open the header URL: they land on the confirmation page.
    expect(get.statusCode).toBe(303);
    expect(get.headers.location).toBe(`http://localhost:3000/correo/baja?t=${encodeURIComponent(token)}`);
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

  it("accepts a multipart one-click body, records the previous preference, ignores unknown workspaces", async () => {
    const acc = await t.createAccount("mail-multi");
    const cookie = await t.cookieFor(acc);
    await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie, ...csrf },
      payload: { emailNotifications: "all" },
    });
    const boundary = "----meri";
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/email/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(AUTH_SECRET, acc.workspaceId))}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`,
      remoteAddress: "10.8.0.4",
    });
    expect(res.statusCode).toBe(200);
    expect(await prefOf(acc.workspaceId)).toBe("off");
    const [row] = await owner.sql<{ before: unknown }[]>`
      select before from audit_log where workspace_id = ${acc.workspaceId} and action = 'notifications.email_unsubscribed'`;
    expect(row?.before).toEqual({ emailNotifications: "all" });
    // A valid signature for a workspace that does not exist: same answer, nothing written.
    const ghost = "0192aaaa-0000-7000-8000-00000000dead";
    expect((await oneClick(signUnsubscribeToken(AUTH_SECRET, ghost), "10.8.0.5")).json()).toEqual({
      ok: true,
    });
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
