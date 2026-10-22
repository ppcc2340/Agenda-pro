import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, createObservability, type Observability } from "@meri/config";
import { createTestApp, type TestApp } from "./test/harness";

/**
 * D-118 end to end: an unhandled error in a real route reaches a Sentry-compatible endpoint over HTTP, with ids
 * only. A local server stands in for Sentry (never tested against sentry.io; `pnpm smoke observability` is).
 */
describe("API errors reach Sentry (D-118)", () => {
  let t: TestApp;
  let sentry: Server;
  let observability: Observability;
  const received: { url: string; auth: string; body: string }[] = [];

  beforeAll(async () => {
    sentry = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push({ url: req.url ?? "", auth: String(req.headers["x-sentry-auth"]), body });
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((r) => sentry.listen(0, "127.0.0.1", r));
    const port = (sentry.address() as AddressInfo).port;
    observability = createObservability({
      service: "api",
      logger: createLogger({ name: "api-test", level: "silent" }),
      sentryDsn: `http://testkey@127.0.0.1:${String(port)}/7`,
      environment: "test",
    });
    t = await createTestApp({ observability });
  });
  afterAll(async () => {
    await t.app.close();
    await new Promise((r) => sentry.close(r));
  });

  it("reports a 500 with route template, trace and workspace ids, and no personal data", async () => {
    const account = await t.createAccount("sentry");
    const cookie = await t.cookieFor(account);
    // The database going away mid-flight is an unhandled error, not a validation or auth problem.
    await t.handle.close();
    const res = await t.app.inject({
      url: "/v1/tasks?search=Propuesta%20Acme",
      headers: { cookie, "x-request-id": "trace-sentry-1" },
    });
    expect(res.statusCode).toBe(500);
    await observability.errors.flush();
    expect(received).toHaveLength(1);
    const sent = received[0];
    expect(sent?.url).toBe("/api/7/envelope/");
    expect(sent?.auth).toContain("sentry_key=testkey");
    const event = JSON.parse(sent?.body.split("\n")[2] ?? "{}") as { tags: Record<string, string> };
    expect(event.tags).toMatchObject({
      service: "api",
      traceId: "trace-sentry-1",
      route: "/v1/tasks",
      workspaceId: account.workspaceId,
    });
    expect(sent?.body).not.toContain(account.email);
    expect(sent?.body).not.toContain("Acme");
    expect(sent?.body).not.toContain("cookie");
  });
});
