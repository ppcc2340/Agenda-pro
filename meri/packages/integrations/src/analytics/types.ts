/** Product analytics (docs/09). Events carry ids and counters only, never email content or client names. */
export const ANALYTICS_EVENTS = [
  "signup",
  "onboarding_completed",
  "calendar_connected",
  "gmail_connected",
  "first_plan_generated",
  "plan_accepted",
  "plan_rejected",
  "capture_created",
  "proposal_shown",
  "proposal_confirmed",
  "proposal_edited",
  "proposal_dismissed",
  "followup_draft_created",
  "commitment_fulfilled",
  "commitment_at_risk_flagged",
  "time_entry_approved",
  "time_export",
  "value_report_viewed",
  "trial_started",
  "subscription_started",
  "subscription_cancelled",
  "integration_error",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export type AnalyticsProps = Record<string, string | number | boolean | null>;

export interface Analytics {
  readonly mode: "noop" | "live";
  track(event: AnalyticsEvent, distinctId: string, props?: AnalyticsProps): void;
  captureError(error: unknown, context?: AnalyticsProps): void;
  flush(): Promise<void>;
}
