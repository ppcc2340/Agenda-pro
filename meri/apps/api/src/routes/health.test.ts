import { Redis } from "ioredis";
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

  it("rate limits by IP and answers RATE_LIMITED after the configured maximum", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await t.app.inject({ url: "/v1/me", remoteAddress: "203.0.113.9" })).statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    const res = await t.app.inject({ url: "/v1/me", remoteAddress: "203.0.113.9" });
    expect(res.json()).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    // Another client is not affected.
    expect((await t.app.inject({ url: "/v1/me", remoteAddress: "203.0.113.10" })).statusCode).toBe(401);
  });
});

describe("rate limit buckets (docs/12 §3)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ rateLimitMax: 3 });
  });
  afterAll(() => t.close());

  it("keys signed-in requests by user, so users behind one web server never share a bucket", async () => {
    const a = await t.createAccount("rl-a");
    const b = await t.createAccount("rl-b");
    const cookieA = await t.cookieFor(a);
    const cookieB = await t.cookieFor(b);
    const me = (cookie: string) => t.app.inject({ url: "/v1/me", headers: { cookie } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await me(cookieA)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await me(cookieB)).statusCode).toBe(200);
  });
});

describe("API response headers (D-081)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("serves JSON with a no-execution CSP, and never lets a shared cache keep a signed-in response", async () => {
    const health = await t.app.inject({ url: "/health" });
    expect(health.headers["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none'");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["strict-transport-security"]).toContain("max-age=");
    expect(health.headers["cache-control"]).toBeUndefined();
    const account = await t.createAccount("hdr-a");
    const me = await t.app.inject({ url: "/v1/me", headers: { cookie: await t.cookieFor(account) } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
  });
});

describe("shared rate limit store (ADR 0007)", () => {
  it("counts one user's requests across API instances through Redis", async () => {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const one = new Redis(url, { maxRetriesPerRequest: 1 });
    const two = new Redis(url, { maxRetriesPerRequest: 1 });
    const a = await createTestApp({ rateLimitMax: 3, rateLimitRedis: one });
    const b = await createTestApp({ rateLimitMax: 3, rateLimitRedis: two });
    try {
      const account = await a.createAccount("rl-shared");
      const cookie = await a.cookieFor(account);
      const hit = (t: TestApp) => t.app.inject({ url: "/v1/me", headers: { cookie } });
      const codes = [(await hit(a)).statusCode, (await hit(b)).statusCode, (await hit(a)).statusCode];
      expect(codes).toEqual([200, 200, 200]);
      expect((await hit(b)).statusCode).toBe(429);
    } finally {
      await a.close();
      await b.close();
      one.disconnect();
      two.disconnect();
    }
  });
});
