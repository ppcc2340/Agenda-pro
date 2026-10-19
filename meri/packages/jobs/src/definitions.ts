import { z } from "zod";
import { withEnvelope } from "./envelope";

/** Payload contracts per queue (docs/13 "Colas"). Every payload also carries the envelope. */
export const CalendarSyncJob = {
  name: "calendar.sync" as const,
  schema: withEnvelope({
    integrationAccountId: z.string().uuid(),
    reason: z.enum(["connect", "poll", "webhook", "manual"]).default("manual"),
  }),
};
export const PlannerReplanJob = {
  name: "planner.replan" as const,
  schema: withEnvelope({
    reason: z.enum(["tasks_changed", "calendar_changed", "day_start", "manual"]).default("manual"),
  }),
};
export const DailyReviewJob = {
  name: "daily.review" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
export const ExamplePingJob = {
  name: "example.ping" as const,
  schema: withEnvelope({ message: z.string().max(200), failTimes: z.number().int().min(0).default(0) }),
};

export type CalendarSyncPayload = z.infer<typeof CalendarSyncJob.schema>;
export type PlannerReplanPayload = z.infer<typeof PlannerReplanJob.schema>;
export type DailyReviewPayload = z.infer<typeof DailyReviewJob.schema>;
