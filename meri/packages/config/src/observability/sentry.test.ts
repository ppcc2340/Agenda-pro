import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createSentryErrorTracker, parseSentryDsn, parseStack, scrubText, type SentryDsn } from "./sentry";

function captureLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: pino({ level: "debug" }, sink), lines };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  lines: unknown[];
}

function fakeFetch(respond: () => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
  const sent: Sent[] = [];
  // The tracker always passes a string URL and a string body.
  const impl = (async (input: string, init?: RequestInit) => {
    sent.push({
      url: input,
      headers: init?.headers as Record<string, string>,
      lines: (init?.body as string).split("\n").map((l) => JSON.parse(l) as unknown),
    });
    return respond();
  }) as typeof fetch;
  return { impl, sent };
}

const DSN = parseSentryDsn("https://pubkey@o7.ingest.sentry.example/1234") as SentryDsn;

function tracker(options: { respond?: () => Response | Promise<Response>; now?: () => number } = {}) {
  const { logger, lines } = captureLogger();
  const f = fakeFetch(options.respond);
  const t = createSentryErrorTracker({
    dsn: DSN,
    service: "api",
    environment: "production",
    release: "abc123",
    logger,
    fetch: f.impl,
    ...(options.now ? { now: options.now } : {}),
  });
  return { t, sent: f.sent, lines };
}

type Event = {
  exception: { values: { type: string; value: string; stacktrace?: { frames: { filename: string }[] } }[] };
  tags: Record<string, string>;
  environment: string;
  release: string;
};
const eventOf = (s: Sent | undefined) => s?.lines[2] as Event;

describe("parseSentryDsn (D-118)", () => {
  it("builds the envelope endpoint and keeps a path prefix", () => {
    expect(DSN).toEqual({
      publicKey: "pubkey",
      envelopeUrl: "https://o7.ingest.sentry.example/api/1234/envelope/",
    });
    expect(parseSentryDsn("https://k@self.example:8443/sentry/9")?.envelopeUrl).toBe(
      "https://self.example:8443/sentry/api/9/envelope/",
    );
    expect(parseSentryDsn("http://k@localhost:9000/2")?.envelopeUrl).toBe(
      "http://localhost:9000/api/2/envelope/",
    );
  });

  it("rejects malformed DSNs and plain http to a remote host", () => {
    for (const bad of [
      "d",
      "https://sentry.example/1",
      "https://k@sentry.example/",
      "https://k@sentry.example/x",
      "http://k@sentry.example/1",
    ])
      expect(parseSentryDsn(bad)).toBeNull();
  });
});

describe("scrubText", () => {
  it("removes emails, credentials, tokens and query strings but keeps ids", () => {
    const out = scrubText(
      "user ana.perez+x@cliente.es failed: Bearer ya29.a0AfH6SMBxyz at https://api.example/cb?code=4/0Abc&state=s " +
        "postgres://meri:pw@db/meri key sk_live_" +
        "a".repeat(40) +
        " ws 3f2b1c4d-1111-4222-8333-444455556666",
    );
    expect(out).not.toMatch(/ana\.perez|cliente\.es|ya29|code=|pw@|sk_live/);
    expect(out).toContain("[email]");
    expect(out).toContain("https://api.example/cb?[redacted]");
    expect(out).toContain("postgres://[redacted]@db/meri");
    expect(out).toContain("3f2b1c4d-1111-4222-8333-444455556666");
  });

  it("truncates long messages", () => {
    expect(scrubText("x ".repeat(2_000)).length).toBeLessThanOrEqual(1_001);
  });
});

describe("parseStack", () => {
  it("reads V8 frames oldest first and marks library frames", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at handler (/app/apps/api/src/routes/tasks.ts:10:5)",
        "    at file:///app/node_modules/fastify/lib/route.js:20:3",
        "    at node:internal/process/task_queues:95:5",
      ].join("\n"),
    );
    expect(frames.map((f) => [f.filename, f.in_app])).toEqual([
      ["node:internal/process/task_queues", false],
      ["/app/node_modules/fastify/lib/route.js", false],
      ["/app/apps/api/src/routes/tasks.ts", true],
    ]);
    expect(frames[2]).toMatchObject({ function: "handler", lineno: 10, colno: 5 });
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("createSentryErrorTracker (D-118)", () => {
  it("sends one envelope with the scrubbed error, allowlisted tags and the auth header", async () => {
    const { t, sent, lines } = tracker();
    const err = new Error("lookup failed for ana@cliente.es", { cause: new TypeError("socket hang up") });
    t.captureException(err, {
      traceId: "trace-1",
      route: "/v1/tasks/:id?q=secret",
      workspaceId: "ws-1",
      statusCode: 500,
      email: "ana@cliente.es",
      body: { title: "Propuesta para Acme" },
    });
    await t.flush();
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(s?.url).toBe("https://o7.ingest.sentry.example/api/1234/envelope/");
    expect(s?.headers["x-sentry-auth"]).toContain("sentry_key=pubkey");
    expect(s?.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(s?.lines[1]).toEqual({ type: "event" });
    const event = eventOf(s);
    expect(event.environment).toBe("production");
    expect(event.release).toBe("abc123");
    expect(event.tags).toEqual({
      service: "api",
      traceId: "trace-1",
      route: "/v1/tasks/:id",
      workspaceId: "ws-1",
      statusCode: "500",
    });
    // Cause first, the thrown error last (Sentry's chained order).
    expect(event.exception.values.map((v) => v.type)).toEqual(["TypeError", "Error"]);
    expect(event.exception.values[1]?.value).toBe("lookup failed for [email]");
    expect(event.exception.values[1]?.stacktrace?.frames.length).toBeGreaterThan(0);
    const wire = JSON.stringify(s?.lines);
    expect(wire).not.toContain("cliente.es");
    expect(wire).not.toContain("Acme");
    expect(wire).not.toContain("secret");
    // The local log keeps the full context, redacted by the logger as everywhere else.
    expect(lines.join("")).toContain("captured exception");
  });

  it("never sends what a thrown non-error carries", async () => {
    const { t, sent } = tracker();
    t.captureException({ email: "ana@cliente.es" });
    t.captureException("raw string with ana@cliente.es");
    await t.flush();
    expect(JSON.stringify(sent.map((s) => s.lines))).not.toContain("cliente");
    expect(eventOf(sent[0]).exception.values[0]).toEqual({ type: "NonError", value: "thrown object" });
  });

  it("deduplicates the same error within a minute and caps events per minute", async () => {
    let clock = 1_000_000;
    const { t, sent } = tracker({ now: () => clock });
    const same = () => new Error("same");
    for (let i = 0; i < 3; i++) t.captureException(same());
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 40; i++) t.captureException(new Error(`distinct ${String(i)}`));
    await t.flush();
    expect(sent).toHaveLength(30);
    expect(t.dropped).toBe(2 + 11);
    clock += 61_000;
    t.captureException(same());
    await t.flush();
    expect(sent).toHaveLength(31);
  });

  it("honours Sentry's 429 Retry-After", async () => {
    let clock = 0;
    let status = 429;
    const { t, sent } = tracker({
      now: () => clock,
      respond: () => new Response(null, { status, headers: { "retry-after": "120" } }),
    });
    t.captureException(new Error("a"));
    await t.flush();
    status = 200;
    clock = 60_000;
    t.captureException(new Error("b"));
    expect(sent).toHaveLength(1);
    clock = 121_000;
    t.captureException(new Error("c"));
    await t.flush();
    expect(sent).toHaveLength(2);
  });

  it("never throws or blocks on network failures, and flush is bounded", async () => {
    const { logger, lines } = captureLogger();
    const failing = createSentryErrorTracker({
      dsn: DSN,
      service: "worker",
      environment: "production",
      logger,
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(() => {
      failing.captureException(new Error("x"));
    }).not.toThrow();
    await failing.flush();
    expect(lines.join("")).toContain("sentry delivery failed");

    const hanging = createSentryErrorTracker({
      dsn: DSN,
      service: "worker",
      environment: "production",
      logger,
      timeoutMs: 50,
      fetch: () => new Promise<Response>(() => {}),
    });
    hanging.captureException(new Error("y"));
    const started = Date.now();
    await hanging.flush();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("logs a rejected event without retrying it", async () => {
    const { t, sent, lines } = tracker({ respond: () => new Response(null, { status: 400 }) });
    t.captureException(new Error("bad"));
    await t.flush();
    expect(sent).toHaveLength(1);
    expect(lines.join("")).toContain("sentry rejected an error event");
  });
});
