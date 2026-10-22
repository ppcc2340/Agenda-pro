import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../load";
import { createObservability, noopErrorTracker, noopTracer, observabilityOptions } from "./index";

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

describe("observability wrappers", () => {
  it("is a no-op without keys and never throws", async () => {
    const { logger, lines } = captureLogger();
    const obs = createObservability({ service: "test", logger });
    expect(obs.enabled).toEqual({ sentry: false, otel: false });
    expect(await obs.tracer.span("op", { workspaceId: "w" }, () => Promise.resolve(42))).toBe(42);
    obs.errors.captureException(new Error("boom"), { traceId: "t" });
    await obs.errors.flush();
    await obs.shutdown();
    expect(lines.join("")).toContain("captured exception");
    expect(lines.join("")).not.toContain("sentry");
    noopErrorTracker.captureException(new Error("x"));
    expect(await noopTracer.span("a", {}, () => Promise.resolve("ok"))).toBe("ok");
  });

  it("sends errors to Sentry with a DSN and flushes them on shutdown (D-118)", async () => {
    const { logger } = captureLogger();
    const urls: string[] = [];
    const obs = createObservability({
      service: "api",
      logger,
      sentryDsn: "https://x@sentry.example/1",
      environment: "production",
      fetch: ((url: string) => {
        urls.push(url);
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof fetch,
    });
    expect(obs.enabled).toEqual({ sentry: true, otel: false });
    obs.errors.captureException(new Error("boom"));
    await obs.shutdown();
    expect(urls).toEqual(["https://sentry.example/api/1/envelope/"]);
  });

  it("falls back to the logs with a malformed DSN and warns that tracing is not exported", () => {
    const { logger, lines } = captureLogger();
    const obs = createObservability({
      service: "api",
      logger,
      sentryDsn: "nope",
      otelEndpoint: "http://otel:4318",
    });
    expect(obs.enabled).toEqual({ sentry: false, otel: true });
    expect(lines.join("")).toContain("SENTRY_DSN is malformed");
    expect(lines.join("")).toContain("tracing export is not wired");
  });

  it("enables Sentry only with ANALYTICS_MODE=live", () => {
    const { logger } = captureLogger();
    const base = {
      ...loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://meri:meri@localhost:5432/meri",
        AUTH_SECRET: "x".repeat(40),
        INTERNAL_API_SECRET: "y".repeat(20),
        LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
    };
    const dsn = "https://x@sentry.example/1";
    const off = observabilityOptions(
      { ...base, env: { ...base.env, SENTRY_DSN: dsn, SENTRY_RELEASE: "r1" } },
      "worker",
      logger,
    );
    expect(off.sentryDsn).toBeUndefined();
    expect(off.release).toBe("r1");
    expect(off.environment).toBe("test");
    const on = observabilityOptions(
      { ...base, modes: { ...base.modes, analytics: "live" }, env: { ...base.env, SENTRY_DSN: dsn } },
      "worker",
      logger,
    );
    expect(on.sentryDsn).toBe(dsn);
  });
});
