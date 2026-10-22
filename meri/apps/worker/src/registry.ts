import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { z } from "zod";
import type { ErrorTracker, Logger } from "@meri/config";
import { withWorkspace, type Db, type WorkspaceTx } from "@meri/db";
import { DEAD_LETTER_QUEUE, JobEnvelope, DEFAULT_JOB_OPTIONS, type QueueName } from "@meri/jobs";

export interface JobContext<T> {
  payload: T;
  workspaceId: string;
  traceId: string;
  jobId: string;
  attempt: number;
  log: Logger;
  /** Runs `fn` under the job's workspace RLS context (set before any data access). */
  withWorkspace<R>(fn: (tx: WorkspaceTx) => Promise<R>): Promise<R>;
}

export interface JobDefinition<S extends z.ZodTypeAny> {
  name: QueueName;
  schema: S;
  concurrency?: number;
  attempts?: number;
  handler: (ctx: JobContext<z.infer<S>>) => Promise<void>;
}

export interface RegistryDeps {
  connection: Redis;
  db: Db;
  logger: Logger;
  /** Key prefix so several environments can share one Redis in tests. */
  prefix?: string;
  /** Receives every job that exhausted its attempts (D-118); retries in between are only logged. */
  errors?: ErrorTracker;
  /** Retry delay strategy; defaults to exponential backoff with jitter. Injected for tests. */
  backoff?: (attemptsMade: number) => number;
}

/**
 * Issue codes and paths without the values: Zod messages quote received values, and this text reaches the
 * dead-letter queue, the logs and Sentry (D-118).
 */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.code} at ${i.path.map((p) => (typeof p === "number" ? "[]" : p)).join(".") || "(root)"}`)
    .join("; ");
}

/** Thrown for jobs that must never be retried (invalid payload). BullMQ skips remaining attempts. */
export class DeadLetterError extends UnrecoverableError {
  override readonly name = "DeadLetterError";
}

/** Exponential backoff with jitter, capped (docs/12 §5). Exposed for tests. */
export function backoffDelayMs(
  attemptsMade: number,
  random: () => number = Math.random,
  baseMs = 1000,
  capMs = 5 * 60_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attemptsMade - 1));
  const jitter = Math.floor(random() * exp * 0.25);
  return exp + jitter;
}

/**
 * Owns queues and workers. Jobs are validated (envelope + payload) before the handler runs; after the last
 * failed attempt the job is copied to the dead-letter queue, which the health endpoint reports.
 */
export class QueueRegistry {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  /** In-flight dead-letter moves, awaited on close so none is lost. */
  private readonly pending = new Set<Promise<unknown>>();
  readonly deadLetter: Queue;

  constructor(private readonly deps: RegistryDeps) {
    this.deadLetter = this.queue(DEAD_LETTER_QUEUE);
  }

  queue(name: QueueName | typeof DEAD_LETTER_QUEUE): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.deps.connection,
        prefix: this.deps.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Enqueue a job. `jobId` makes retries/duplicates idempotent (docs/12 §5). */
  async enqueue<S extends z.ZodTypeAny>(
    def: JobDefinition<S>,
    payload: z.infer<S>,
    options: JobsOptions = {},
  ): Promise<Job> {
    const parsed = JobEnvelope.and(def.schema).parse(payload);
    return this.queue(def.name).add(def.name, parsed, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: def.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
      ...options,
    });
  }

  register<S extends z.ZodTypeAny>(def: JobDefinition<S>): Worker {
    const worker = new Worker(
      def.name,
      async (job) => {
        const envelope = JobEnvelope.safeParse(job.data);
        if (!envelope.success) {
          throw new DeadLetterError(
            `job ${job.id ?? "?"} rejected: missing workspaceId/traceId (${summarizeIssues(envelope.error)})`,
          );
        }
        const payload = def.schema.safeParse(job.data);
        if (!payload.success)
          throw new DeadLetterError(
            `job ${job.id ?? "?"} rejected: invalid payload (${summarizeIssues(payload.error)})`,
          );
        const log = this.deps.logger.child({
          jobId: job.id,
          queue: def.name,
          workspaceId: envelope.data.workspaceId,
          traceId: envelope.data.traceId,
          attempt: job.attemptsMade + 1,
        });
        await def.handler({
          payload: payload.data as z.infer<S>,
          workspaceId: envelope.data.workspaceId,
          traceId: envelope.data.traceId,
          jobId: job.id ?? "",
          attempt: job.attemptsMade + 1,
          log,
          withWorkspace: (fn) => withWorkspace(this.deps.db, envelope.data.workspaceId, fn),
        });
      },
      {
        connection: this.deps.connection,
        prefix: this.deps.prefix,
        concurrency: def.concurrency ?? 2,
        settings: { backoffStrategy: (attemptsMade) => (this.deps.backoff ?? backoffDelayMs)(attemptsMade) },
      },
    );
    worker.on("failed", (job, err) => {
      if (!job) return;
      const exhausted = err instanceof DeadLetterError || job.attemptsMade >= (job.opts.attempts ?? 1);
      this.deps.logger.warn(
        { jobId: job.id, queue: def.name, attempt: job.attemptsMade, exhausted, err: err.message },
        "job failed",
      );
      if (exhausted) {
        const envelope = JobEnvelope.safeParse(job.data);
        this.deps.errors?.captureException(err, {
          source: "job",
          queue: def.name,
          jobId: job.id,
          attempt: job.attemptsMade,
          ...(envelope.success
            ? { workspaceId: envelope.data.workspaceId, traceId: envelope.data.traceId }
            : {}),
        });
        const move = this.deadLetter
          .add(
            def.name,
            { ...job.data, failedJobId: job.id, error: err.message },
            { attempts: 1, jobId: `dlq_${def.name}_${job.id ?? ""}` },
          )
          .catch((e: unknown) => {
            this.deps.logger.error({ err: e }, "could not move job to dead-letter queue");
          })
          .finally(() => {
            this.pending.delete(move);
          });
        this.pending.add(move);
      }
    });
    this.workers.push(worker);
    return worker;
  }

  async health(): Promise<{
    queues: Record<string, { waiting: number; active: number; failed: number; delayed: number }>;
    deadLetter: number;
  }> {
    const queues: Record<string, { waiting: number; active: number; failed: number; delayed: number }> = {};
    for (const [name, q] of this.queues) {
      if (name === DEAD_LETTER_QUEUE) continue;
      const c = await q.getJobCounts("waiting", "active", "failed", "delayed");
      queues[name] = {
        waiting: c.waiting ?? 0,
        active: c.active ?? 0,
        failed: c.failed ?? 0,
        delayed: c.delayed ?? 0,
      };
    }
    return { queues, deadLetter: await this.deadLetter.getWaitingCount() };
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.pending]);
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
