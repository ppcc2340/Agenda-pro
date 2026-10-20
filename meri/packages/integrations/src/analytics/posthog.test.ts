import { describe, expect, it } from "vitest";
import { PostHogAnalytics } from "./posthog";

function recorder(status = 200) {
  const bodies: { url: string; body: { api_key: string; batch: Record<string, unknown>[] } }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(init.body as string) as (typeof bodies)[number]["body"] });
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const now = () => new Date("2026-10-20T08:40:00.000Z");

describe("PostHogAnalytics (live adapter, fetch stubbed)", () => {
  it("buffers events and sends one batch on flush", async () => {
    const { bodies, fetchImpl } = recorder();
    const ph = new PostHogAnalytics({
      flushIntervalMs: 0,
      apiKey: "phc_x",
      host: "https://eu.i.posthog.com/",
      fetch: fetchImpl,
      now,
    });
    ph.track("signup", "u1", { plan: "trial" });
    ph.track("plan_accepted", "u1");
    expect(bodies).toHaveLength(0);
    await ph.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.url).toBe("https://eu.i.posthog.com/batch/");
    expect(bodies[0]?.body.api_key).toBe("phc_x");
    expect(bodies[0]?.body.batch).toEqual([
      {
        event: "signup",
        distinct_id: "u1",
        properties: { plan: "trial" },
        timestamp: "2026-10-20T08:40:00.000Z",
      },
      { event: "plan_accepted", distinct_id: "u1", properties: {}, timestamp: "2026-10-20T08:40:00.000Z" },
    ]);
    await ph.flush();
    expect(bodies).toHaveLength(1);
  });

  it("flushes automatically once the batch is full", async () => {
    const { bodies, fetchImpl } = recorder();
    const ph = new PostHogAnalytics({
      apiKey: "k",
      host: "https://h",
      fetch: fetchImpl,
      batchSize: 2,
      now,
      flushIntervalMs: 0,
    });
    ph.track("signup", "a");
    ph.track("signup", "b");
    await ph.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.body.batch).toHaveLength(2);
  });

  it("sends errors as $exception with the class only, never the message", async () => {
    const { bodies, fetchImpl } = recorder();
    const ph = new PostHogAnalytics({
      apiKey: "k",
      host: "https://h",
      fetch: fetchImpl,
      now,
      flushIntervalMs: 0,
    });
    ph.captureError(new TypeError("secret client name inside"), { route: "/v1/tasks" });
    await ph.flush();
    const sent = bodies[0]?.body.batch[0];
    expect(sent).toMatchObject({
      event: "$exception",
      properties: { $exception_type: "TypeError", route: "/v1/tasks" },
    });
    expect(JSON.stringify(sent)).not.toContain("secret client name");
  });

  it("never throws on delivery failures; reports them through onError", async () => {
    const errors: unknown[] = [];
    const failing = new PostHogAnalytics({
      flushIntervalMs: 0,
      apiKey: "k",
      host: "https://h",
      fetch: () => Promise.reject(new Error("offline")),
      onError: (e) => errors.push(e),
    });
    failing.track("signup", "a");
    await expect(failing.flush()).resolves.toBeUndefined();
    const rejected = new PostHogAnalytics({
      flushIntervalMs: 0,
      apiKey: "k",
      host: "https://h",
      fetch: recorder(500).fetchImpl,
      onError: (e) => errors.push(e),
    });
    rejected.track("signup", "a");
    await rejected.flush();
    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
      "offline",
      "PostHog responded 500",
    ]);
  });
});

describe("PostHogAnalytics timer", () => {
  it("flushes buffered events on its interval even with low traffic", async () => {
    const { bodies, fetchImpl } = recorder();
    const ph = new PostHogAnalytics({
      apiKey: "k",
      host: "https://h",
      fetch: fetchImpl,
      now,
      flushIntervalMs: 20,
    });
    ph.track("signup", "a");
    await new Promise((r) => setTimeout(r, 60));
    expect(bodies).toHaveLength(1);
  });
});
