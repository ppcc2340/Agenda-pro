import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { z } from "zod";
import { JobEnvelope, type QueueName } from "./envelope";

/** Enqueues jobs. The api uses it to trigger work; tests use the in-memory implementation. */
export interface JobDispatcher {
  enqueue<S extends z.ZodTypeAny>(
    def: { name: QueueName; schema: S },
    payload: z.infer<S>,
    options?: JobsOptions,
  ): Promise<{ id: string }>;
  close(): Promise<void>;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "custom" },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createDispatcher(connection: Redis, prefix?: string): JobDispatcher {
  const queues = new Map<string, Queue>();
  const queue = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, q);
    }
    return q;
  };
  return {
    async enqueue(def, payload, options = {}) {
      const parsed = JobEnvelope.and(def.schema).parse(payload);
      const job = await queue(def.name).add(def.name, parsed, { ...DEFAULT_JOB_OPTIONS, ...options });
      return { id: job.id ?? "" };
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

/** Records jobs instead of sending them (api tests). Optionally runs a handler inline. */
export class InMemoryDispatcher implements JobDispatcher {
  readonly jobs: { name: QueueName; payload: unknown; options: JobsOptions }[] = [];
  private counter = 0;
  constructor(private readonly inline?: (name: QueueName, payload: unknown) => Promise<void>) {}
  async enqueue<S extends z.ZodTypeAny>(
    def: { name: QueueName; schema: S },
    payload: z.infer<S>,
    options: JobsOptions = {},
  ): Promise<{ id: string }> {
    const parsed = JobEnvelope.and(def.schema).parse(payload);
    this.jobs.push({ name: def.name, payload: parsed, options });
    if (this.inline) await this.inline(def.name, parsed);
    return { id: String(++this.counter) };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
