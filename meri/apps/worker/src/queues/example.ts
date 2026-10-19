import { z } from "zod";
import { withEnvelope } from "../envelope";
import type { JobDefinition } from "../registry";

export const ExamplePing = withEnvelope({ message: z.string().max(200), failTimes: z.number().int().min(0).default(0) });

/** Phase 0 example job: proves validation, retries/backoff and the dead-letter path. */
export const examplePing: JobDefinition<typeof ExamplePing> = {
  name: "example.ping",
  schema: ExamplePing,
  attempts: 3,
  async handler(ctx) {
    if (ctx.attempt <= ctx.payload.failTimes) {
      throw new Error(`simulated transient failure ${String(ctx.attempt)}/${String(ctx.payload.failTimes)}`);
    }
    ctx.log.info({ message: ctx.payload.message }, "pong");
    await Promise.resolve();
  },
};
