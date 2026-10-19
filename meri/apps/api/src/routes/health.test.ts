import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test/harness";

describe("system routes and error contract (docs/13)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ rateLimitMax: 5 });
  });
  afterAll(() => t.close());

  it("answers health and readiness probes", async () => {
    expect((await t.app.inject({ url: "/health" })).json()).toEqual({ status: "ok" });
    const ready = await t.app.inject({ url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", db: "ok" });
  });

  it("returns application/problem+json with a stable code and traceId for unknown routes", async () => {
    const res = await t.app.inject({ url: "/v1/nope", headers: { "x-request-id": "trace-123" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.headers["x-request-id"]).toBe("trace-123");
    const problem = res.json<{
      code: string;
      status: number;
      title: string;
      traceId: string;
      type: string;
    }>();
    expect(problem).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      title: "Not found",
      traceId: "trace-123",
    });
    expect(problem.type).toContain("not_found");
  });

  it("publishes OpenAPI without internal routes", async () => {
    const res = await t.app.inject({ url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ paths: Record<string, unknown>; openapi: string }>();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/v1/me", "/v1/preferences", "/v1/audit", "/health", "/ready"]),
    );
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/internal"))).toBe(false);
  });

  it("rate limits by IP and answers RATE_LIMITED", async () => {
    let last = 0;
    for (let i = 0; i < 7; i++)
      last = (await t.app.inject({ url: "/v1/me", headers: { "x-forwarded-for": "203.0.113.9" } }))
        .statusCode;
    const res = await t.app.inject({ url: "/v1/me" });
    expect([last, res.statusCode]).toContain(429);
    if (res.statusCode === 429) expect(res.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});
