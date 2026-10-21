import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, csrf, type TestApp } from "../test/harness";

/** ADR 0007: custom header + the browser's provenance headers on every cookie-authenticated mutation. */
describe("CSRF defence in two layers", () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestApp({ env: { APP_URL: "https://app.meri.test", API_URL: "https://api.meri.test" } });
    cookie = await t.cookieFor(await t.createAccount("csrf-a"));
  });
  afterAll(() => t.close());
  const write = (headers: Record<string, string>) =>
    t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie, ...headers },
      payload: { contingencyPct: 20 },
    });

  it("accepts same-origin browser requests and server-to-server calls without provenance headers", async () => {
    expect((await write({ ...csrf })).statusCode).toBe(200);
    expect(
      (await write({ ...csrf, origin: "https://app.meri.test", "sec-fetch-site": "same-origin" })).statusCode,
    ).toBe(200);
    expect((await write({ ...csrf, origin: "https://api.meri.test" })).statusCode).toBe(200);
  });

  it("refuses the missing header, cross-site or same-site requests, foreign and null origins", async () => {
    expect((await write({})).statusCode).toBe(403);
    expect((await write({ ...csrf, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    // A sibling subdomain (previews) is same-site, not same-origin.
    expect((await write({ ...csrf, "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await write({ ...csrf, origin: "https://evil.test" })).statusCode).toBe(403);
    expect((await write({ ...csrf, origin: "https://app.meri.test.evil.test" })).statusCode).toBe(403);
    expect((await write({ ...csrf, origin: "null" })).statusCode).toBe(403);
    expect((await write({ ...csrf, origin: "http://app.meri.test" })).statusCode).toBe(403);
  });

  it("cannot be skipped with a percent-encoded /v1 path (the router decodes it, the check must too)", async () => {
    for (const url of ["/%761/preferences", "/v%31/preferences", "/%76%31/preferences"]) {
      const forged = await t.app.inject({
        method: "PUT",
        url,
        headers: { cookie },
        payload: { contingencyPct: 20 },
      });
      expect(forged.statusCode).toBe(403);
      // Without a session the fail-closed gate answers first, encoded or not.
      const anonymous = await t.app.inject({
        method: "PUT",
        url,
        headers: csrf,
        payload: { contingencyPct: 20 },
      });
      expect(anonymous.statusCode).toBe(401);
    }
    // Positive control: the encoded path does reach the route when the request is legitimate.
    const ok = await t.app.inject({
      method: "PUT",
      url: "/%761/preferences",
      headers: { cookie, ...csrf },
      payload: { contingencyPct: 20 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("never applies to reads", async () => {
    const res = await t.app.inject({ url: "/v1/me", headers: { cookie, "sec-fetch-site": "cross-site" } });
    expect(res.statusCode).toBe(200);
  });
});
