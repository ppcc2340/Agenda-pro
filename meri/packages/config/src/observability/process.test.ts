import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { reportFatalErrors } from "./process";

describe("reportFatalErrors (D-118)", () => {
  it("captures, flushes and exits once on a crash", async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: "debug" },
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    );
    const captured: { source: unknown }[] = [];
    let flushed = 0;
    const exits: number[] = [];
    const remove = reportFatalErrors(
      {
        captureException: (_e, ctx) => captured.push({ source: ctx?.source }),
        flush: () => {
          flushed++;
          return Promise.resolve();
        },
      },
      logger,
      (code) => exits.push(code),
    );
    try {
      process.emit("unhandledRejection", new Error("lost promise"), Promise.resolve());
      process.emit("uncaughtException", new Error("boom"));
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      remove();
    }
    expect(captured).toEqual([{ source: "unhandledRejection" }, { source: "uncaughtException" }]);
    expect(flushed).toBe(1);
    expect(exits).toEqual([1]);
    expect(lines.join("")).toContain("process crashed");
  });
});
