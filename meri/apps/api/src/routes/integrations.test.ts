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
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/integrations/${account.id}`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).statusCode,
    ).toBe(204);
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
});
