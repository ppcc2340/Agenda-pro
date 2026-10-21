/**
 * Typed product analytics (D-065, docs/09): one Zod schema per event whose properties only admit ids (uuid), closed
 * enums, numbers and booleans. No free string can travel, so neither a subject nor a client name can leak.
 * `distinctId` is the workspace id. Emit on the server where the fact happens, after the transaction commits ([M9]).
 */
import { z } from "zod";
import type { Analytics, AnalyticsEvent } from "@meri/integrations";

const id = z.string().uuid();
const count = z.number().int().min(0).max(1_000_000);
const proposalKind = z.enum(["capture", "commitment", "followup", "reschedule", "time_entry", "client_link"]);
const paidPlan = z.enum(["pro", "pro_plus"]);

export const ANALYTICS_SCHEMAS = {
  signup: z.object({}).strict(),
  onboarding_completed: z.object({ calendarConnected: z.boolean() }).strict(),
  calendar_connected: z.object({}).strict(),
  gmail_connected: z.object({}).strict(),
  first_plan_generated: z.object({ blocks: count }).strict(),
  plan_accepted: z.object({ proposalId: id, changes: count }).strict(),
  plan_rejected: z.object({ proposalId: id }).strict(),
  capture_created: z.object({ source: z.enum(["rules", "ai"]) }).strict(),
  proposal_shown: z.object({ proposalId: id, kind: proposalKind }).strict(),
  proposal_confirmed: z.object({ proposalId: id, kind: proposalKind }).strict(),
  proposal_edited: z.object({ proposalId: id, kind: proposalKind }).strict(),
  proposal_dismissed: z.object({ proposalId: id, kind: proposalKind }).strict(),
  followup_draft_created: z.object({ commitmentId: id, source: z.enum(["ai", "template"]) }).strict(),
  commitment_fulfilled: z.object({ commitmentId: id, onTime: z.boolean() }).strict(),
  commitment_at_risk_flagged: z.object({ entityType: z.enum(["task", "commitment"]), entityId: id }).strict(),
  time_entry_approved: z.object({ entryId: id, minutes: count }).strict(),
  time_export: z.object({ scope: z.enum(["week", "month"]), entries: count }).strict(),
  value_report_viewed: z.object({ period: z.enum(["week", "month"]) }).strict(),
  trial_started: z.object({ trialDays: count }).strict(),
  subscription_started: z
    .object({ plan: paidPlan, interval: z.enum(["month", "year"]), cohort: z.enum(["A", "B"]) })
    .strict(),
  subscription_cancelled: z
    .object({
      reason: z.enum(["price", "not_using", "missing_feature", "switched_tool", "privacy", "other"]),
    })
    .strict(),
  integration_error: z
    .object({
      provider: z.enum(["google", "anthropic", "stripe"]),
      kind: z.enum(["AuthExpired", "RateLimited", "Transient", "Permanent"]),
    })
    .strict(),
} satisfies Record<AnalyticsEvent, z.ZodTypeAny>;

export type AnalyticsPropsOf<E extends AnalyticsEvent> = z.infer<(typeof ANALYTICS_SCHEMAS)[E]>;

/**
 * Validates and sends one event. An invalid payload is a programming error: it is dropped (never sent) and reported
 * through `captureError` (tests assert none), so analytics can never break the request that emitted it.
 */
export function track<E extends AnalyticsEvent>(
  analytics: Analytics,
  event: E,
  workspaceId: string,
  props: AnalyticsPropsOf<E>,
): void {
  const parsed = ANALYTICS_SCHEMAS[event].safeParse(props);
  if (!parsed.success || !id.safeParse(workspaceId).success) {
    analytics.captureError(new Error(`analytics event ${event} rejected by its schema`), { event });
    return;
  }
  analytics.track(event, workspaceId, parsed.data);
}
