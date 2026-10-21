import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFixtures, type Fixtures } from "../test/authz-fixtures";
import { AUTHZ_MATRIX, type AuthzCase, type AuthzRule } from "../test/authz-matrix";
import { createTestApp, csrf, type TestApp } from "../test/harness";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DENIED = new Set([400, 403, 404, 409, 422]);

/**
 * P5-06 authorization matrix (ADR 0007): every route is classified; every /v1 route refuses anonymous, deleted and
 * cross-site callers; workspace B, holding workspace A's ids, is denied or isolated and never changes A.
 */
describe("authorization matrix over every registered route", () => {
  let t: TestApp;
  let a: Fixtures;
  let b: Fixtures;
  let deletedCookie: string;
  const routes = () =>
    t.app.routeTable.map((r) => ({ key: `${r.method} ${r.url}`, method: r.method as Method, url: r.url }));
  const fill = (url: string, id: string) => url.replace(":provider", "google").replace(":id", id);
  const ruleOf = (key: string): AuthzRule => {
    const rule = AUTHZ_MATRIX[key];
    if (!rule) throw new Error(`route not classified in the authorization matrix: ${key}`);
    return rule;
  };
  const snapshotA = async () => {
    const res = await t.app.inject({ url: "/v1/account/export", headers: { cookie: a.cookie } });
    const doc = res.json<Record<string, unknown>>();
    // A's own exports add «account.exported» to its activity, and the timestamp moves: everything else is compared.
    const { activity: _activity, exportedAt: _at, generatedAt: _gen, ...rest } = doc;
    return JSON.stringify(rest);
  };
  /** A's values found in a response, ignoring those the caller itself sent (an echo of its own input reveals nothing). */
  const leaks = (body: string, request: string) =>
    a.secrets.filter((s) => body.includes(s) && !request.includes(s));

  beforeAll(async () => {
    t = await createTestApp();
    a = await makeFixtures(t, "authz-a");
    b = await makeFixtures(t, "authz-b");
    const gone = await t.createAccount("authz-deleted");
    deletedCookie = await t.cookieFor(gone);
    await t.app.inject({ method: "DELETE", url: "/v1/account", headers: { cookie: deletedCookie, ...csrf } });
  });
  afterAll(() => t.close());

  it("classifies every registered route, and lists no route that does not exist", () => {
    const registered = routes().map((r) => r.key);
    expect(registered.filter((k) => !(k in AUTHZ_MATRIX))).toEqual([]);
    expect(Object.keys(AUTHZ_MATRIX).filter((k) => !registered.includes(k))).toEqual([]);
    for (const r of routes()) expect(ruleOf(r.key).kind === "outside", r.key).toBe(!r.url.startsWith("/v1/"));
  });

  it("every /v1 route answers 401 without a session and with a deleted account's session", async () => {
    const failures: string[] = [];
    for (const r of routes().filter((x) => x.url.startsWith("/v1/"))) {
      // The router percent-decodes paths: the encoded spelling must be refused too.
      for (const url of [fill(r.url, a.task), fill(r.url, a.task).replace(/^\/v1\//, "/%761/")]) {
        for (const cookie of [undefined, deletedCookie]) {
          const res = await t.app.inject({
            method: r.method,
            url,
            headers: cookie ? { cookie, ...csrf } : { ...csrf },
          });
          if (res.statusCode !== 401)
            failures.push(
              `${url} ${r.method} (${cookie ? "deleted" : "anonymous"}) → ${String(res.statusCode)}`,
            );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("every mutating /v1 route refuses a request without the CSRF header, or from another site", async () => {
    const failures: string[] = [];
    for (const r of routes().filter((x) => x.url.startsWith("/v1/") && MUTATING.has(x.method))) {
      for (const url of [fill(r.url, b.task), fill(r.url, b.task).replace(/^\/v1\//, "/%761/")]) {
        const bare = await t.app.inject({ method: r.method, url, headers: { cookie: b.cookie } });
        const cross = await t.app.inject({
          method: r.method,
          url,
          headers: { cookie: b.cookie, ...csrf, "sec-fetch-site": "cross-site" },
        });
        if (bare.statusCode !== 403 || cross.statusCode !== 403)
          failures.push(`${url} ${r.method} → ${String(bare.statusCode)}/${String(cross.statusCode)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("workspace B holding workspace A's ids is denied or isolated, never sees A's data and never changes it", async () => {
    const before = await snapshotA();
    const failures: string[] = [];
    const controls: { where: string; run: (c: Fixtures) => Promise<{ statusCode: number; body: string }> }[] =
      [];
    let n = 0;
    for (const r of routes().filter((x) => x.url.startsWith("/v1/"))) {
      const rule = ruleOf(r.key);
      if (rule.kind === "outside" || (rule.kind === "own" && rule.destructive)) continue;
      const cases: (AuthzCase & { label: string })[] =
        rule.kind === "own"
          ? [
              {
                label: "own",
                path: () => `${fill(r.url, b.task)}${rule.query ? `?${rule.query}` : ""}`,
                ...(rule.body ? { body: () => rule.body ?? {} } : {}),
                expect: "isolated",
              },
            ]
          : rule.cases.map((c, i) => ({ ...c, label: `case ${String(i)}` }));
      for (const kase of cases) {
        const path = kase.path
          ? kase.path(a, b)
          : fill(r.url, rule.kind === "tenant" && rule.param ? a[rule.param] : b.task);
        const payload = kase.body?.(a, b);
        const res = await t.app.inject({
          method: r.method,
          url: path,
          headers: { cookie: b.cookie, ...csrf, "idempotency-key": `authz-${String(++n)}` },
          ...(payload !== undefined
            ? { payload }
            : MUTATING.has(r.method) && r.method !== "DELETE"
              ? { payload: {} }
              : {}),
        });
        const where = `${r.key} [${kase.label}]`;
        if (res.statusCode >= 500) failures.push(`${where} → ${String(res.statusCode)}`);
        if (kase.expect === "denied" && !DENIED.has(res.statusCode))
          failures.push(`${where} → ${String(res.statusCode)} (expected denial)`);
        const leaked = leaks(res.body, `${path} ${JSON.stringify(payload ?? {})}`);
        // Positive control (after the loop, each on a fresh owner C): the same request by the owner of the ids
        // succeeds, so the denial above came from tenancy and not from an invalid or impossible request.
        if (kase.expect === "denied" && kase.noControl === undefined) {
          controls.push({
            where,
            run: (c) => {
              const ownPath = kase.path
                ? kase.path(c, c)
                : fill(r.url, rule.kind === "tenant" && rule.param ? c[rule.param] : c.task);
              const ownPayload = kase.body?.(c, c);
              return t.app.inject({
                method: r.method,
                url: ownPath,
                headers: { cookie: c.cookie, ...csrf, "idempotency-key": `authz-own-${String(++n)}` },
                ...(ownPayload !== undefined
                  ? { payload: ownPayload }
                  : MUTATING.has(r.method) && r.method !== "DELETE"
                    ? { payload: {} }
                    : {}),
              });
            },
          });
        }
        if (leaked.length > 0) failures.push(`${where} leaked ${leaked.join(", ")}`);
      }
    }
    for (const [i, control] of controls.entries()) {
      const own = await control.run(await makeFixtures(t, `authz-c${String(i)}`));
      if (own.statusCode >= 300)
        failures.push(
          `${control.where} positive control → ${String(own.statusCode)} ${own.body.slice(0, 300)}`,
        );
    }
    expect(failures).toEqual([]);
    expect(await snapshotA()).toBe(before);
  }, 180_000);

  it("revoking sessions or deleting another account never touches workspace A", async () => {
    const before = await snapshotA();
    for (const label of ["authz-revoker", "authz-leaver"]) {
      const c = await t.createAccount(label);
      const cookie = await t.cookieFor(c);
      const res = await t.app.inject({
        method: label === "authz-revoker" ? "POST" : "DELETE",
        url: label === "authz-revoker" ? "/v1/account/sessions/revoke" : "/v1/account",
        headers: { cookie, ...csrf },
      });
      expect(res.statusCode).toBe(204);
    }
    expect((await t.app.inject({ url: "/v1/me", headers: { cookie: a.cookie } })).statusCode).toBe(200);
    expect(await snapshotA()).toBe(before);
  });
});
