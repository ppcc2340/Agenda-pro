import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@meri/config";
import { createDb, type DbHandle } from "@meri/db";
import { DEAD_LETTER_QUEUE } from "./envelope";
import { buildHealthServer } from "./health";
import { examplePing } from "./queues/example";
import { backoffDelayMs, QueueRegistry } from "./registry";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const WS = "01930000-0000-7000-8000-000000000001";

function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      void check().then((ok) => {
        if (ok) resolve();
        else if (Date.now() - started > timeoutMs) reject(new Error("timeout"));
        else setTimeout(tick, 50);
      });
    };
    tick();
  });
}

describe("backoffDelayMs", () => {
  it("grows exponentially with bounded jitter and a cap", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(1000);
    expect(backoffDelayMs(2, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, () => 0.999)).toBeLessThan(4000 * 1.25);
    expect(backoffDelayMs(3, () => 0.999)).toBeGreaterThan(4000);
    expect(backoffDelayMs(40, () => 0)).toBe(300_000);
  });
});

describe("QueueRegistry with real Redis", () => {
  const prefix = `meri-test-${Date.now().toString(36)}`;
  let connection: Redis;
  let handle: DbHandle;
  let registry: QueueRegistry;
  const logger = createLogger({ name: "worker-test", level: "silent" });

  beforeAll(() => {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    handle = createDb(TEST_APP_URL, { max: 1 });
    // Fast retries for tests; production uses backoffDelayMs (tested above).
    registry = new QueueRegistry({ connection, db: handle.db, logger, prefix, backoff: () => 10 });
    registry.register({ ...examplePing, attempts: 3 });
  });
  afterAll(async () => {
    await registry.close();
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length) await connection.del(...keys);
    connection.disconnect();
    await handle.close();
  });

  it("rejects a job without the envelope before enqueueing", async () => {
    const bad = { message: "x" } as unknown as Parameters<typeof registry.enqueue<typeof examplePing.schema>>[1];
    await expect(registry.enqueue(examplePing, bad)).rejects.toThrow(/workspaceId/);
  });

  it("runs a job, retries transient failures with backoff and reports health", async () => {
    const job = await registry.enqueue(examplePing, { workspaceId: WS, traceId: "t-1", message: "hola", failTimes: 1 });
    // After the first failed attempt the job is delayed, then retried; wait for the final state only.
    await waitFor(async () => (await job.getState()) === "completed");
    const refreshed = await registry.queue("example.ping").getJob(job.id ?? "");
    expect(refreshed?.attemptsMade).toBe(2);
    const health = await buildHealthServer(registry, logger);
    const res = await health.inject({ url: "/ready" });
    const body = res.json<{ status: string; queues: Record<string, { active: number }>; deadLetter: number }>();
    expect(body.status).toBe("ready");
    expect(typeof body.queues["example.ping"]?.active).toBe("number");
    await health.close();
  });

  it("moves a job to the dead-letter queue after the last failed attempt", async () => {
    const job = await registry.enqueue(examplePing, { workspaceId: WS, traceId: "t-2", message: "boom", failTimes: 10 });
    await waitFor(async () => (await registry.deadLetter.getWaitingCount()) > 0, 15_000);
    const dead = await registry.deadLetter.getWaiting();
    expect(dead.some((d) => (d.data as { failedJobId?: string }).failedJobId === job.id)).toBe(true);
    expect((await registry.health()).deadLetter).toBeGreaterThan(0);
    expect(registry.queue(DEAD_LETTER_QUEUE)).toBe(registry.deadLetter);
  });

  it("sends a malformed payload straight to the dead-letter queue (no retries)", async () => {
    const q = registry.queue("example.ping");
    const job = await q.add("example.ping", { workspaceId: "not-a-uuid", traceId: "t-3", message: "x" }, { attempts: 5, jobId: `bad-${Date.now().toString(36)}` });
    await waitFor(async () => (await registry.deadLetter.getWaiting()).some((d) => (d.data as { failedJobId?: string }).failedJobId === job.id), 15_000);
    const refreshed = await q.getJob(job.id ?? "");
    expect(refreshed?.attemptsMade).toBe(1);
  });
});
