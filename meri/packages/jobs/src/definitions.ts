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
export const GmailSyncJob = {
  name: "gmail.sync" as const,
  schema: withEnvelope({
    integrationAccountId: z.string().uuid(),
    reason: z.enum(["connect", "poll", "webhook", "manual"]).default("manual"),
  }),
};
export const ExtractCommitmentsJob = {
  name: "ai.extract_commitments" as const,
  schema: withEnvelope({ threadId: z.string().uuid(), messageIds: z.array(z.string()).min(1).max(50) }),
};
export const FollowupsScanJob = {
  name: "followups.scan" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
export const ClientsScanJob = {
  name: "clients.scan" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
export const BriefingsPrepareJob = {
  name: "briefings.prepare" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
export const TimeInferJob = {
  name: "time.infer" as const,
  schema: withEnvelope({
    reason: z
      .enum(["daily", "calendar_changed", "block_completed", "event_assigned", "manual"])
      .default("manual"),
  }),
};
export const DataRetentionJob = {
  name: "data.retention" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
/** F-16 / ADR 0007: physical purge of one workspace logically deleted more than 30 days ago (daily dispatcher). */
export const DataDeleteAccountJob = {
  name: "data.delete_account" as const,
  schema: withEnvelope({}),
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
/** D-062: per workspace and month (docs/13 [L17]); also emits the [M10] `trial.ending` notice. */
export const BillingUsageRollupJob = {
  name: "billing.usage_rollup" as const,
  schema: withEnvelope({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
};
/** D-064: end-of-day close notification, once per workspace and local day. */
export const DailyCloseJob = {
  name: "daily.close" as const,
  schema: withEnvelope({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
};
export const ExamplePingJob = {
  name: "example.ping" as const,
  schema: withEnvelope({ message: z.string().max(200), failTimes: z.number().int().min(0).default(0) }),
};

/** D-115: email copy of one in-app notification (one job per notification id). */
export const NotifyEmailJob = {
  name: "notify.email" as const,
  schema: withEnvelope({ notificationId: z.string().uuid() }),
};

export type NotifyEmailPayload = z.infer<typeof NotifyEmailJob.schema>;
export type CalendarSyncPayload = z.infer<typeof CalendarSyncJob.schema>;
export type GmailSyncPayload = z.infer<typeof GmailSyncJob.schema>;
export type ExtractCommitmentsPayload = z.infer<typeof ExtractCommitmentsJob.schema>;
export type FollowupsScanPayload = z.infer<typeof FollowupsScanJob.schema>;
export type ClientsScanPayload = z.infer<typeof ClientsScanJob.schema>;
export type BriefingsPreparePayload = z.infer<typeof BriefingsPrepareJob.schema>;
export type TimeInferPayload = z.infer<typeof TimeInferJob.schema>;
export type DataRetentionPayload = z.infer<typeof DataRetentionJob.schema>;
export type PlannerReplanPayload = z.infer<typeof PlannerReplanJob.schema>;
export type DailyReviewPayload = z.infer<typeof DailyReviewJob.schema>;
export type BillingUsageRollupPayload = z.infer<typeof BillingUsageRollupJob.schema>;
export type DailyClosePayload = z.infer<typeof DailyCloseJob.schema>;
export type DataDeleteAccountPayload = z.infer<typeof DataDeleteAccountJob.schema>;
