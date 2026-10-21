import { UserId, WorkspaceId } from "@meri/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, csrf, INTERNAL_SECRET, type TestApp } from "../test/harness";
import { INTERNAL_HEADER } from "../plugins/internal";

describe("POST /internal/auth/bootstrap (ADR 0001)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("rejects a missing or wrong secret without leaking which", async () => {
    const none = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      payload: { email: "x@y.z" },
    });
    expect(none.statusCode).toBe(401);
    const wrong = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers: { [INTERNAL_HEADER]: "nope" },
      payload: { email: "x@y.z" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("creates the account on first call and returns the same ids afterwards", async () => {
    const email = `boot-${Date.now().toString(36)}@test.local`;
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const first = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email, subject: `dev:${email}`, name: "Boot" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ email, name: "Boot", created: true, locale: "es" });
    const second = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email, subject: `dev:${email}` },
    });
    expect(second.json()).toMatchObject({ created: false, userId: first.json<{ userId: string }>().userId });
    const invalid = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email: "not-an-email", subject: "dev:x" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const noSubject = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email },
    });
    expect(noSubject.statusCode).toBe(400);
  });

  it("binds the account to the provider identity: a recycled address with another subject is refused (ADR 0007)", async () => {
    const email = `recycled-${Date.now().toString(36)}@test.local`;
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const boot = (subject: string) =>
      t.app.inject({ method: "POST", url: "/internal/auth/bootstrap", headers, payload: { email, subject } });
    const run = Date.now().toString(36);
    expect((await boot(`google:111-${run}`)).statusCode).toBe(200);
    expect((await boot(`google:111-${run}`)).json()).toMatchObject({ created: false });
    const other = await boot(`google:222-${run}`);
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: "CONFLICT" });
  });

  it("follows a renamed Google account by its subject instead of creating a second account", async () => {
    const run = Date.now().toString(36);
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const boot = (email: string) =>
      t.app.inject({
        method: "POST",
        url: "/internal/auth/bootstrap",
        headers,
        payload: { email, subject: `google:renamed-${run}` },
      });
    const first = await boot(`old-${run}@test.local`);
    const renamed = await boot(`new-${run}@test.local`);
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      created: false,
      email: `new-${run}@test.local`,
      userId: first.json<{ userId: string }>().userId,
    });
  });

  it("a deleted account is never renamed back to life by its subject", async () => {
    const run = Date.now().toString(36);
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const boot = (email: string) =>
      t.app.inject({
        method: "POST",
        url: "/internal/auth/bootstrap",
        headers,
        payload: { email, subject: `google:deleted-${run}` },
      });
    const first = await boot(`gone-${run}@test.local`);
    const body = first.json<{ userId: string; workspaceId: string; email: string }>();
    const cookie = await t.cookieFor({
      userId: UserId.parse(body.userId),
      workspaceId: WorkspaceId.parse(body.workspaceId),
      email: body.email,
    });
    expect(
      (await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie, ...csrf } })).statusCode,
    ).toBe(204);
    const renamed = await boot(`back-${run}@test.local`);
    expect(renamed.statusCode).toBe(409);
    // The deleted user keeps its address until the purge; no account exists under the new one.
    const again = await boot(`gone-${run}@test.local`);
    expect(again.statusCode).toBe(409);
  });

  it("limits bootstrap calls per email after the body is read, not per web-server IP", async () => {
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const email = `burst-${Date.now().toString(36)}@test.local`;
    const codes: number[] = [];
    for (let i = 0; i < 31; i++)
      codes.push(
        (
          await t.app.inject({
            method: "POST",
            url: "/internal/auth/bootstrap",
            headers,
            payload: { email, subject: `dev:${email}` },
          })
        ).statusCode,
      );
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    const other = `calm-${Date.now().toString(36)}@test.local`;
    const fine = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email: other, subject: `dev:${other}` },
    });
    expect(fine.statusCode).toBe(200);
  });
});

describe("internal routes and the IP rate limit", () => {
  it("never throttles server-to-server bootstrap calls (one web server IP serves every login)", async () => {
    const strict = await createTestApp({ rateLimitMax: 1 });
    try {
      const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
      for (let i = 0; i < 3; i++) {
        const res = await strict.app.inject({
          method: "POST",
          url: "/internal/auth/bootstrap",
          headers,
          payload: {
            email: `rl-${String(i)}-${Date.now().toString(36)}@test.local`,
            subject: `dev:rl-${String(i)}-${Date.now().toString(36)}`,
          },
        });
        expect(res.statusCode).toBe(200);
      }
      const limited = await strict.app.inject({ url: "/v1/me" });
      await strict.app.inject({ url: "/v1/me" });
      const third = await strict.app.inject({ url: "/v1/me" });
      expect([limited.statusCode, third.statusCode]).toContain(429);
    } finally {
      await strict.close();
    }
  });
});
