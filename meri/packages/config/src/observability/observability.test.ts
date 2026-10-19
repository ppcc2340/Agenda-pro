import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createObservability, noopErrorTracker, noopTracer } from "./index";

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
    expect(lines.join("")).not.toContain("observability keys present");
    noopErrorTracker.captureException(new Error("x"));
    expect(await noopTracer.span("a", {}, () => Promise.resolve("ok"))).toBe("ok");
  });

  it("reports which live backends are configured", () => {
    const { logger, lines } = captureLogger();
    const obs = createObservability({ service: "test", logger, sentryDsn: "https://x@sentry.example/1" });
    expect(obs.enabled.sentry).toBe(true);
    expect(lines.join("")).toContain("observability keys present");
  });
});
