import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { reportFatalErrors, FATAL_FLUSH_MS } from "./process";

describe("reportFatalErrors (D-118)", () => {
  it("captures as fatal, flushes once with a short bound and exits once", async () => {
    const proc = new EventEmitter();
    const captured: { source: unknown; fatal: boolean | undefined }[] = [];
    const bounds: (number | undefined)[] = [];
    const exits: number[] = [];
    const remove = reportFatalErrors(
      {
        captureException: (_e, ctx, options) => {
          captured.push({ source: ctx?.source, fatal: options?.fatal });
        },
        flush: (bound) => {
          bounds.push(bound);
          return Promise.resolve();
        },
      },
      (code) => {
        exits.push(code);
      },
      proc as unknown as Pick<NodeJS.Process, "on" | "off">,
    );
    proc.emit("unhandledRejection", new Error("lost promise"));
    proc.emit("uncaughtException", new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toEqual([
      { source: "unhandledRejection", fatal: true },
      { source: "uncaughtException", fatal: true },
    ]);
    expect(bounds).toEqual([FATAL_FLUSH_MS]);
    expect(exits).toEqual([1]);
    remove();
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});
