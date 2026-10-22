import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@meri/config";
import { schedule } from "./dispatchers";

describe("schedule (D-118)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a failing cron with its name and skips overlapping runs", async () => {
    vi.useFakeTimers();
    const captured: Record<string, unknown>[] = [];
    let release: () => void = () => {};
    let calls = 0;
    const stop = schedule(
      "notify.email",
      1_000,
      () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("db down"));
        return new Promise<void>((r) => {
          release = r;
        });
      },
      createLogger({ name: "schedule-test", level: "silent" }),
      {
        captureException: (_e, ctx) => {
          captured.push(ctx ?? {});
        },
        flush: () => Promise.resolve(),
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(captured).toEqual([{ source: "cron", queue: "notify.email" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    release();
    stop();
  });
});
