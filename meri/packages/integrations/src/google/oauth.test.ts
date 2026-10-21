import { createHash } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../errors";
import { GoogleHttp } from "./http";
import { LiveGoogleOAuth } from "./oauth";
import { formOf, SimulatedGoogle } from "./test-server";

const NOW = new Date("2026-10-21T09:00:00Z");
const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function server() {
  const google = new SimulatedGoogle();
  const codes = new Map([["good-code", challenge("verifier-1")]]);
  google
    .on("POST", "/token", (req) => {
      const form = formOf(req);
      if (form.client_secret !== "secret") return { status: 401, json: { error: "invalid_client" } };
      if (form.grant_type === "authorization_code") {
        const expected = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        if (!expected || challenge(form.code_verifier ?? "") !== expected)
          return { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } };
        return {
          json: {
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3599,
            scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
            token_type: "Bearer",
          },
        };
      }
      if (form.refresh_token === "revoked")
        return {
          status: 400,
          json: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        };
      return { json: { access_token: "at-2", expires_in: 3599, token_type: "Bearer" } };
    })
    .on("GET", "/userinfo", (req) =>
      req.headers.authorization === "Bearer at-1"
        ? { json: { sub: "1234567890", email: "Ana@Acme.com", email_verified: true } }
        : { status: 401, json: { error: { code: 401, message: "Invalid Credentials" } } },
    )
    .on("POST", "/revoke", (req) =>
      formOf(req).token === "gone"
        ? { status: 400, json: { error: "invalid_token" } }
        : { status: 200, json: {} },
    );
  const oauth = new LiveGoogleOAuth({
    clientId: "client-1",
    clientSecret: "secret",
    fetch: google.fetch,
    allowedHosts: ["accounts.test", "oauth.test"],
    now: () => NOW,
    endpoints: {
      authorize: "https://accounts.test/auth",
      token: "https://oauth.test/token",
      userinfo: "https://oauth.test/userinfo",
      revoke: "https://oauth.test/revoke",
    },
  });
  return { google, oauth };
}

describe("LiveGoogleOAuth (against a simulated Google)", () => {
  it("builds an offline, consented, PKCE authorization URL with the identity scopes added", () => {
    const { oauth } = server();
    const url = new URL(
      oauth.authorizationUrl({
        state: "s-1",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        redirectUri: "https://api.meri.test/v1/integrations/google/callback",
        loginHint: "ana@acme.com",
        codeChallenge: challenge("verifier-1"),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.test/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      response_type: "code",
      state: "s-1",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge: challenge("verifier-1"),
      code_challenge_method: "S256",
      login_hint: "ana@acme.com",
    });
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("exchanges the code with its verifier and reads the identity from userinfo", async () => {
    const { oauth, google } = server();
    const tokens = await oauth.exchangeCode({
      code: "good-code",
      redirectUri: "https://cb",
      codeVerifier: "verifier-1",
    });
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: "2026-10-21T09:59:59.000Z",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
      externalAccountId: "1234567890",
      email: "ana@acme.com",
    });
    const form = formOf(google.requests[0] ?? { method: "", url: new URL("x:"), headers: {}, body: "" });
    expect(form).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: "verifier-1",
      client_id: "client-1",
    });
  });

  it("a wrong verifier or a reused code is a permanent failure of the callback", async () => {
    const { oauth } = server();
    await expect(
      oauth.exchangeCode({ code: "good-code", redirectUri: "https://cb", codeVerifier: "other" }),
    ).rejects.toMatchObject({ kind: "Permanent" });
    // Burnt by the first attempt, like Google.
    await expect(
      oauth.exchangeCode({ code: "good-code", redirectUri: "https://cb", codeVerifier: "verifier-1" }),
    ).rejects.toMatchObject({ kind: "Permanent" });
  });

  it("refuses an unverified Google address and a response without refresh token", async () => {
    const { oauth, google } = server();
    google.on("GET", "/userinfo", () => ({ json: { sub: "1", email: "x@y.test", email_verified: false } }));
    await expect(
      oauth.exchangeCode({ code: "good-code", redirectUri: "https://cb", codeVerifier: "verifier-1" }),
    ).rejects.toThrow(/not verified/);
    const second = server();
    second.google.on("POST", "/token", () => ({ json: { access_token: "a", expires_in: 3600 } }));
    await expect(
      second.oauth.exchangeCode({ code: "good-code", redirectUri: "https://cb", codeVerifier: "verifier-1" }),
    ).rejects.toThrow(/refresh token/);
  });

  it("refresh renews the access token only; a revoked grant is AuthExpired", async () => {
    const { oauth } = server();
    expect(await oauth.refresh("rt-1")).toEqual({
      accessToken: "at-2",
      refreshToken: null,
      expiresAt: "2026-10-21T09:59:59.000Z",
      scopes: null,
    });
    await expect(oauth.refresh("revoked")).rejects.toMatchObject({ kind: "AuthExpired" });
  });

  it("revoke treats an already invalid token as done", async () => {
    const { oauth, google } = server();
    await oauth.revoke("rt-1");
    await oauth.revoke("gone");
    expect(google.requests.map((r) => formOf(r).token)).toEqual(["rt-1", "gone"]);
  });
});

describe("GoogleHttp error mapping", () => {
  const call = async (reply: { status: number; json?: unknown; headers?: Record<string, string> }) => {
    const google = new SimulatedGoogle().on("GET", "/x", () => reply);
    const http = new GoogleHttp("google-test", { fetch: google.fetch, allowedHosts: ["api.test"] });
    return http.request(z.object({ ok: z.boolean() }), { url: "https://api.test/x", allow: [410] });
  };
  const kindOf = async (reply: Parameters<typeof call>[0]) =>
    call(reply).then(
      () => "ok",
      (e: unknown) => (e instanceof IntegrationError ? e.kind : "other"),
    );

  it("maps statuses and Google reasons to the typed connector errors", async () => {
    expect(
      await kindOf({ status: 401, json: { error: { code: 401, message: "Invalid Credentials" } } }),
    ).toBe("AuthExpired");
    expect(await kindOf({ status: 429, json: {} })).toBe("RateLimited");
    expect(
      await kindOf({
        status: 403,
        json: { error: { code: 403, message: "x", errors: [{ reason: "userRateLimitExceeded" }] } },
      }),
    ).toBe("RateLimited");
    expect(
      await kindOf({
        status: 403,
        json: { error: { code: 403, message: "x", errors: [{ reason: "forbidden" }] } },
      }),
    ).toBe("Permanent");
    expect(await kindOf({ status: 503, json: {} })).toBe("Transient");
    expect(await kindOf({ status: 400, json: { error: "invalid_grant" } })).toBe("AuthExpired");
    expect(await kindOf({ status: 404, json: {} })).toBe("Permanent");
    // Unexpected body shape: refused, not trusted.
    expect(await kindOf({ status: 200, json: { ok: "yes" } })).toBe("Permanent");
  });

  it("returns allowed statuses to the caller and honours Retry-After", async () => {
    expect(await call({ status: 410, json: { error: { code: 410, message: "Gone" } } })).toEqual({
      status: 410,
      body: null,
    });
    const err = await call({ status: 429, json: {}, headers: { "retry-after": "7" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).options.retryAfterMs).toBe(7000);
  });

  it("a network failure or timeout is transient and never leaks the token", async () => {
    const http = new GoogleHttp("google-test", {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      timeoutMs: 5,
      allowedHosts: ["api.test"],
    });
    const err = await http
      .request(z.unknown(), { url: "https://api.test/x", token: () => Promise.resolve("secret-token") })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "Transient" });
    expect((err as Error).message).not.toContain("secret-token");
  });

  it("never calls a host outside the allowlist, follows no redirect and caps the response size", async () => {
    const google = new SimulatedGoogle().on("GET", "/x", () => ({ json: { ok: true } }));
    const http = new GoogleHttp("google-test", {
      fetch: google.fetch,
      allowedHosts: ["api.test"],
      maxResponseBytes: 20,
    });
    await expect(http.request(z.unknown(), { url: "https://evil.test/x" })).rejects.toMatchObject({
      kind: "Permanent",
    });
    await expect(http.request(z.unknown(), { url: "http://api.test/x" })).rejects.toMatchObject({
      kind: "Permanent",
    });
    expect(google.requests).toHaveLength(0);
    const big = new SimulatedGoogle().on("GET", "/x", () => ({ json: { ok: true, pad: "x".repeat(100) } }));
    const capped = new GoogleHttp("google-test", {
      fetch: big.fetch,
      allowedHosts: ["api.test"],
      maxResponseBytes: 20,
    });
    await expect(capped.request(z.unknown(), { url: "https://api.test/x" })).rejects.toThrow(/too large/);
    // Production defaults allow only Google's hosts.
    const prod = new GoogleHttp("google-test", { fetch: google.fetch });
    await expect(prod.request(z.unknown(), { url: "https://api.test/x" })).rejects.toThrow(/refusing/);
    let redirect: RequestRedirect | undefined;
    const spy = new GoogleHttp("google-test", {
      allowedHosts: ["api.test"],
      fetch: (_u, init) => {
        redirect = init?.redirect;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    await spy.request(z.unknown(), { url: "https://api.test/x" });
    expect(redirect).toBe("error");
  });

  it("error messages carry the status and Google's reason codes, never response text", async () => {
    const err = await call({
      status: 400,
      json: {
        error: {
          code: 400,
          message: "Invalid value for to: ana@acme.com secret-payload",
          errors: [{ reason: "invalid" }],
        },
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("google-test 400 invalid");
  });

  it("retries once with a forced refresh after a 401, and a second 401 is AuthExpired", async () => {
    const google = new SimulatedGoogle().on("GET", "/x", (req) =>
      req.headers.authorization === "Bearer fresh" ? { json: { ok: true } } : { status: 401, json: {} },
    );
    const http = new GoogleHttp("google-test", { fetch: google.fetch, allowedHosts: ["api.test"] });
    const calls: (boolean | undefined)[] = [];
    const token = (o?: { forceRefresh?: boolean }) => {
      calls.push(o?.forceRefresh);
      return Promise.resolve(o?.forceRefresh ? "fresh" : "stale");
    };
    expect(
      (await http.request(z.object({ ok: z.boolean() }), { url: "https://api.test/x", token })).body,
    ).toEqual({ ok: true });
    expect(calls).toEqual([undefined, true]);
    const never = (o?: { forceRefresh?: boolean }) =>
      Promise.resolve(o?.forceRefresh ? "still-bad" : "stale");
    await expect(
      http.request(z.unknown(), { url: "https://api.test/x", token: never }),
    ).rejects.toMatchObject({
      kind: "AuthExpired",
    });
    expect(google.requests).toHaveLength(4);
    // A missing scope needs a reconnect too.
    const scope = new SimulatedGoogle().on("GET", "/x", () => ({
      status: 403,
      json: { error: { code: 403, message: "x", errors: [{ reason: "insufficientPermissions" }] } },
    }));
    const h2 = new GoogleHttp("google-test", { fetch: scope.fetch, allowedHosts: ["api.test"] });
    await expect(h2.request(z.unknown(), { url: "https://api.test/x" })).rejects.toMatchObject({
      kind: "AuthExpired",
    });
  });
});

describe("token endpoint errors (review: invalid_client is configuration, not an expired grant)", () => {
  it("a wrong client secret is Permanent, a revoked refresh token is AuthExpired", async () => {
    const google = new SimulatedGoogle();
    google.on("POST", "/token", (req) =>
      formOf(req).client_secret !== "secret"
        ? { status: 401, json: { error: "invalid_client" } }
        : { status: 400, json: { error: "invalid_grant" } },
    );
    const make = (clientSecret: string) =>
      new LiveGoogleOAuth({
        clientId: "id",
        clientSecret,
        fetch: google.fetch,
        endpoints: {
          authorize: "https://accounts.test/auth",
          token: "https://oauth.test/token",
          revoke: "https://oauth.test/revoke",
          userinfo: "https://oauth.test/userinfo",
        },
        allowedHosts: ["accounts.test", "oauth.test"],
      });
    await expect(make("wrong").refresh("rt")).rejects.toMatchObject({ kind: "Permanent" });
    await expect(make("secret").refresh("rt")).rejects.toMatchObject({ kind: "AuthExpired" });
  });
});
