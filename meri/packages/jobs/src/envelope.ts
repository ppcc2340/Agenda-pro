import { z } from "zod";

/** Every job payload carries the tenant and trace context (docs/13 "Colas", docs/12 §5). */
export const JobEnvelope = z.object({
  workspaceId: z.string().uuid(),
  traceId: z.string().min(1).max(128),
});
export type JobEnvelope = z.infer<typeof JobEnvelope>;

export function withEnvelope<T extends z.ZodRawShape>(shape: T) {
  return JobEnvelope.extend(shape);
}

/** Queue names from docs/13. Phase 0 only wires `example.ping`; the rest are registered by their phases. */
export const QUEUE_NAMES = [
  "example.ping",
  "gmail.sync",
  "calendar.sync",
  "ai.extract_commitments",
  "ai.brief_client",
  "planner.replan",
  "followups.scan",
  "clients.scan",
  "time.infer",
  "briefings.prepare",
  "daily.review",
  "billing.usage_rollup",
  "data.delete_account",
  "data.retention",
  "integrations.renew_channels",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
export const DEAD_LETTER_QUEUE = "dead-letter";
