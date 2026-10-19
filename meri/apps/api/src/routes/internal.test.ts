import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, INTERNAL_SECRET, type TestApp } from "../test/harness";
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
      payload: { email, name: "Boot" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ email, name: "Boot", created: true, locale: "es" });
    const second = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email },
    });
    expect(second.json()).toMatchObject({ created: false, userId: first.json<{ userId: string }>().userId });
    const invalid = await t.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email: "not-an-email" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
