import type { FakeGoogleOAuth } from "@meri/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEncryptedTokens, withWorkspace, type AccountIdentity } from "@meri/db";
import type { FakeCalendar } from "@meri/integrations";
import { syncCalendarAccount } from "@meri/jobs";
import { createTestApp, csrf, type TestApp } from "../test/harness";

interface AccountJson {
  id: string;
  status: string;
  email: string | null;
  scopes: string[];
}

describe("Google Calendar connection (F-04, D-021)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("cal-a");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(await t.createAccount("cal-b"));
  });
  afterAll(() => t.close());

  async function connect(cookie: string): Promise<AccountJson> {
    const start = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: { cookie, ...csrf },
    });
    expect(start.statusCode).toBe(200);
    const stateCookie = start.cookies.find((c) => c.name === "meri.oauth.state");
    expect(stateCookie?.httpOnly).toBe(true);
    const url = new URL(start.json<{ url: string }>().url);
    const cb = await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookie}; meri.oauth.state=${stateCookie?.value ?? ""}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("integration=connected");
    const list = await t.app.inject({ url: "/v1/integrations", headers: { cookie } });
    const account = list.json<{ items: AccountJson[] }>().items[0];
    if (!account) throw new Error("no account");
    return account;
  }

  it("connects through OAuth with state verification, stores encrypted tokens and enqueues the first sync", async () => {
    const account = await connect(cookieA);
    expect(account).toMatchObject({ status: "healthy", email: a.email });
    expect(account.scopes.some((scope) => scope.includes("calendar"))).toBe(true);
    expect(
      t.dispatcher.jobs.some(
        (j) => j.name === "calendar.sync" && (j.payload as { reason: string }).reason === "connect",
      ),
    ).toBe(true);
    const row = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      getEncryptedTokens(tx, a.workspaceId, account.id),
    );
    const blob = row?.encryptedTokens ?? "";
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain("fake-access");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const start = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: { cookie: cookieA, ...csrf },
    });
    const url = new URL(start.json<{ url: string }>().url);
    const cb = await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookieA}; meri.oauth.state=another` },
    });
    expect(cb.statusCode).toBe(403);
    expect(cb.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("a validly signed state from another flow is refused: the state parameter itself is compared", async () => {
    const connect = () =>
      t.app.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: { cookie: cookieA, ...csrf },
      });
    const first = await connect();
    const second = await connect();
    const firstCookie = first.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
    const secondUrl = new URL(second.json<{ url: string }>().url);
    const before = (await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } })).json<{
      items: unknown[];
    }>().items.length;
    // Flow 1's cookie is genuinely signed for this workspace; only its state differs from flow 2's callback.
    const cb = await t.app.inject({
      url: `${secondUrl.pathname}${secondUrl.search}`,
      headers: { cookie: `${cookieA}; meri.oauth.state=${firstCookie}` },
    });
    expect(cb.statusCode).toBe(403);
    expect(cb.json<{ detail: string }>().detail).toMatch(/state/i);
    const after = (await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } })).json<{
      items: unknown[];
    }>().items.length;
    expect(after).toBe(before);
  });

  it("binds the signed state to the workspace that started the flow and to its PKCE verifier (ADR 0007)", async () => {
    const start = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: { cookie: cookieA, ...csrf },
    });
    const sealed = start.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
    const url = new URL(start.json<{ url: string }>().url);
    // The authorization URL never carries the verifier; the cookie is signed, not a bare state.
    expect(url.searchParams.get("state")).not.toBe(sealed);
    expect(sealed.split(".")).toHaveLength(2);
    // Another workspace's session replaying A's cookie and code is refused before any exchange.
    const other = await t.createAccount("oauth-replay");
    const replay = await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${await t.cookieFor(other)}; meri.oauth.state=${sealed}` },
    });
    expect(replay.statusCode).toBe(403);
    // A tampered cookie (another verifier or workspace) breaks the signature.
    const [body = "", tag = ""] = sealed.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...payload, v: "x".repeat(43) })).toString("base64url");
    const tampered = await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookieA}; meri.oauth.state=${forged}.${tag}` },
    });
    expect(tampered.statusCode).toBe(403);
  });

  it("serves mirrored events after a sync, keeps Meri away from foreign events, and isolates tenants", async () => {
    const list = await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } });
    const account = list.json<{ items: AccountJson[] }>().items[0];
    if (!account) throw new Error("no account");
    const cal = t.integrations.calendarFor(a.email) as FakeCalendar;
    const meeting = cal.addExternalEvent({
      title: "Reunión con Acme",
      startsAt: "2026-10-19T12:30:00Z",
      endsAt: "2026-10-19T13:15:00Z",
    });
    const result = await syncCalendarAccount(
      {
        db: t.handle.db,
        integrations: t.integrations,
        keys: t.integrations.kms.keys,
        logger: t.app.log,
        now: () => new Date("2026-10-19T10:40:00Z"),
      },
      a.workspaceId,
      account.id,
    );
    expect(result.status).toBe("synced");
    const events = await t.app.inject({
      url: "/v1/calendar/events?from=2026-10-19T00:00:00Z&to=2026-10-20T00:00:00Z",
      headers: { cookie: cookieA },
    });
    expect(events.json<{ items: { externalId: string; origin: string }[] }>().items).toEqual([
      expect.objectContaining({ externalId: meeting.externalId, origin: "external" }),
    ]);
    expect(
      (
        await t.app.inject({
          url: "/v1/calendar/events?from=2026-10-19T00:00:00Z&to=2026-10-20T00:00:00Z",
          headers: { cookie: cookieB },
        })
      ).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    expect(
      (
        await t.app.inject({
          url: "/v1/calendar/events?from=2026-10-19T00:00:00Z&to=2027-10-20T00:00:00Z",
          headers: { cookie: cookieA },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/integrations/${account.id}/pause`,
          headers: { cookie: cookieB, ...csrf },
        })
      ).statusCode,
    ).toBe(404);
    // Meri never modifies a foreign event through the connector contract.
    await expect(cal.deleteMeriEvent(cal.primaryCalendarId, meeting.externalId)).rejects.toThrow(/non-Meri/);
  });

  it("pauses, resumes, syncs on demand and disconnects purging mirrored events", async () => {
    const list = await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } });
    const account = list.json<{ items: AccountJson[] }>().items[0];
    if (!account) throw new Error("no account");
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/integrations/${account.id}/pause`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).json<AccountJson>().status,
    ).toBe("paused");
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/integrations/${account.id}/pause`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).json<AccountJson>().status,
    ).toBe("healthy");
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/integrations/${account.id}/sync`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).statusCode,
    ).toBe(202);
    const revokedBefore = (t.integrations.oauth as FakeGoogleOAuth).revoked.length;
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/integrations/${account.id}`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).statusCode,
    ).toBe(204);
    // docs/06 §1: disconnecting also revokes the token at the provider.
    expect((t.integrations.oauth as FakeGoogleOAuth).revoked.length).toBe(revokedBefore + 1);
    expect(
      (await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } })).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);
    expect(
      (
        await t.app.inject({
          url: "/v1/calendar/events?from=2026-10-19T00:00:00Z&to=2026-10-20T00:00:00Z",
          headers: { cookie: cookieA },
        })
      ).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it("accepts Google push notifications only with the channel token", async () => {
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/webhooks/google/calendar",
          headers: { "x-goog-channel-token": "wrong", "x-goog-channel-id": "x" },
        })
      ).statusCode,
    ).toBe(403);
    const before = t.dispatcher.jobs.length;
    const ok = await t.app.inject({
      method: "POST",
      url: "/webhooks/google/calendar",
      headers: {
        "x-goog-channel-token": "test-channel-token",
        "x-goog-channel-id": `${a.workspaceId}:0192aaaa-0000-7000-8000-000000000001`,
      },
    });
    expect(ok.statusCode).toBe(204);
    expect(t.dispatcher.jobs.length).toBe(before + 1);
  });

  it("adds Gmail scopes incrementally on the same Google account and enqueues the first mail sync (ADR 0004)", async () => {
    const c = await t.createAccount("integrations-c");
    const cookie = await t.cookieFor(c);
    const start = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect?feature=calendar",
      headers: { cookie, ...csrf },
    });
    const state = start.cookies.find((x) => x.name === "meri.oauth.state")?.value ?? "";
    const url = new URL(start.json<{ url: string }>().url);
    await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookie}; meri.oauth.state=${state}` },
    });
    const start2 = await t.app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect?feature=gmail",
      headers: { cookie, ...csrf },
    });
    const state2 = start2.cookies.find((x) => x.name === "meri.oauth.state")?.value ?? "";
    const url2 = new URL(start2.json<{ url: string }>().url);
    expect(url2.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url2.searchParams.get("scope")).not.toContain("gmail.send");
    await t.app.inject({
      url: `${url2.pathname}${url2.search}`,
      headers: { cookie: `${cookie}; meri.oauth.state=${state2}` },
    });
    const list = await t.app.inject({ url: "/v1/integrations", headers: { cookie } });
    const accounts = list.json<{ items: AccountJson[] }>().items;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.scopes.some((s) => s.includes("calendar"))).toBe(true);
    expect(accounts[0]?.scopes.some((s) => s.includes("gmail.readonly"))).toBe(true);
    expect(t.dispatcher.jobs.some((j) => j.name === "gmail.sync")).toBe(true);
    const manual = await t.app.inject({
      method: "POST",
      url: `/v1/integrations/${accounts[0]?.id ?? ""}/mail/sync`,
      headers: { cookie, ...csrf },
    });
    expect(manual.statusCode).toBe(202);
    const webhook = await t.app.inject({
      method: "POST",
      url: "/webhooks/google/gmail",
      headers: {
        "x-goog-channel-token": "wrong",
        "x-goog-channel-id": `${c.workspaceId}:${accounts[0]?.id ?? ""}`,
      },
    });
    expect(webhook.statusCode).toBe(403);
  });
});
