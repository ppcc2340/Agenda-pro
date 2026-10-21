/** API view types consumed by the web (mirror of apps/api Zod schemas). */
export type TaskStatus =
  "pending" | "scheduled" | "in_progress" | "blocked" | "waiting_on_third_party" | "at_risk" | "completed";

export interface Task {
  id: string;
  clientId: string | null;
  projectId: string | null;
  parentId: string | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  kind: "deep" | "shallow";
  priority: number;
  dueAt: string | null;
  deadlineType: "soft" | "hard";
  estimateMinutes: number | null;
  tags: string[];
  origin: string;
  blockedBy: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  id: string;
  kind: "capture" | "commitment" | "followup" | "reschedule" | "time_entry" | "client_link";
  status: "pending" | "confirmed" | "edited" | "dismissed" | "expired";
  payload: Record<string, unknown>;
  confidence: number | null;
  explanation: string | null;
  sourceRef: { type: string; id: string; url?: string } | null;
  createdAt: string;
}

export interface CapturePayload {
  text: string;
  title: string;
  clientId: string | null;
  clientName: string | null;
  dueAt: string | null;
  dueText: string | null;
  estimateMinutes: number | null;
  priority: number | null;
  kind: "deep" | "shallow" | null;
  source: "rules" | "ai";
}

export interface IntegrationAccount {
  id: string;
  provider: string;
  email: string | null;
  scopes: string[];
  status: "healthy" | "needs_reauth" | "degraded" | "paused" | "revoked";
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------- Plan (GET /v1/plan) ----------
export interface Reason {
  code: string;
  params: Record<string, unknown>;
}

export interface Block {
  id: string;
  taskId: string;
  startsAt: string;
  endsAt: string;
  pinned: boolean;
  reason: Reason[];
  calendarEventId: string | null;
  planVersion: number;
  completedAt: string | null;
}

export interface PlannedBlock {
  taskId: string;
  startsAt: string;
  endsAt: string;
  pinned: boolean;
  reasons: Reason[];
}

export interface Risk {
  taskId: string;
  slackHours: number;
  cause: string;
}

export interface Conflict {
  code: string;
  taskIds: string[];
  details: Record<string, string | number>;
  alternatives: string[];
}

export interface PendingProposal {
  id: string;
  createdAt: string;
  basePlanVersion: number;
  summary: { added: number; removed: number; moved: number };
  added: PlannedBlock[];
  removed: { blockId: string; taskId: string; startsAt: string; endsAt: string }[];
  moved: {
    blockId: string;
    taskId: string;
    from: { startsAt: string; endsAt: string };
    to: { startsAt: string; endsAt: string };
    reasons: Reason[];
  }[];
}

export interface Plan {
  planVersion: number;
  generatedAt: string | null;
  blocks: Block[];
  tasks: (Task & { risk: { cause: string; slackHours: number; since: string } | null })[];
  risks: Risk[];
  conflicts: Conflict[];
  unscheduled: { taskId: string; reason: string }[];
  pendingProposal: PendingProposal | null;
  /** Contingency reserve per local day (D-051), drawn hatched at the end of the day. */
  margin: { day: string; minutes: number; startsAt: string; endsAt: string }[];
}

export interface CalendarEvent {
  id: string;
  integrationAccountId: string | null;
  externalId: string;
  title: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendees: string[];
  clientId: string | null;
  origin: "meri" | "external";
  busy: boolean;
}

export interface Notification {
  id: string;
  kind: "digest" | "risk" | "proposals" | "plan" | "integration" | "billing";
  title: string;
  body: string;
  template: string;
  params: Record<string, string | number>;
  refs: { type: string; id: string }[];
  day: string;
  readAt: string | null;
  createdAt: string;
}

// ---------- Commitments (phase 2) ----------
export type CommitmentDirection = "owed_by_me" | "owed_to_me";
export type CommitmentKind = "explicit" | "inferred" | "suggested";
export type CommitmentStatus = "proposed" | "confirmed" | "fulfilled" | "at_risk" | "broken" | "dismissed";

export interface Commitment {
  id: string;
  clientId: string | null;
  direction: CommitmentDirection;
  kind: CommitmentKind;
  status: CommitmentStatus;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  action: string;
  dueAt: string | null;
  dueText: string | null;
  confidence: number | null;
  evidence: string | null;
  threadId: string | null;
  threadUrl: string | null;
  taskId: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

/** Payload of a `commitment` proposal (ai.extract_commitments). */
export interface CommitmentPayload {
  commitmentId: string;
  direction: CommitmentDirection;
  action: string;
  dueAt: string | null;
  dueText: string | null;
  kind: CommitmentKind;
  confidence: number;
  evidence: string;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  clientId: string | null;
  threadId: string;
  externalThreadId: string;
  subject: string | null;
  externalMessageId: string;
}

/** Payload of a `followup` proposal (followups.scan). */
export interface FollowupPayload {
  kind: "overdue_commitment" | "unanswered_thread";
  commitmentId: string | null;
  threadId: string | null;
  externalThreadId: string | null;
  subject: string | null;
  action: string;
  dueAt: string | null;
  dueText: string | null;
  daysLate: number;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  clientId: string | null;
  clientName: string | null;
  suggestedAction: "draft" | "waiting_task";
}

export interface FollowupDraft {
  to: string;
  subject: string;
  body: string;
  source: "ai" | "template";
  language: "es" | "en";
}

export interface Contact {
  id: string;
  clientId: string | null;
  email: string;
  name: string | null;
  muted: boolean;
  createdAt: string;
}

export interface MailExclusion {
  id: string;
  kind: "sender" | "domain" | "label";
  value: string;
  createdAt: string;
}

export type AiPauseReason = "access_inactive" | "credits_exhausted" | "cost_cap";

export interface AccessView {
  active: boolean;
  reason: "trial" | "trial_card_on_file" | "active" | "past_due" | "trial_ended" | "canceled" | "unpaid";
  trialDaysLeft: number | null;
}

export interface CreditsView {
  allowance: number;
  used: number;
  remaining: number;
}

export interface AiUsage {
  period: string;
  usedUsd: number;
  capUsd: number;
  paused: boolean;
  reason: AiPauseReason | null;
  mode: "fake" | "live";
  credits: CreditsView & { ratio: number };
  access: AccessView;
}

export type PlanCode = "trial" | "pro" | "pro_plus";
export type BillingInterval = "month" | "year";

export interface BillingSubscription {
  plan: PlanCode;
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete";
  interval: BillingInterval | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
  hasBillingAccount: boolean;
  access: AccessView;
  entitlements: { maxClients: number; aiCreditsMonthly: number; retentionDays: number; features: string[] };
  credits: CreditsView;
  mode: "fake" | "live";
  priceCohort: "A" | "B";
  prices: Record<"pro" | "pro_plus", Record<BillingInterval, number>>;
}

export type ValueMethod =
  | "commitment_fulfilled_on_time"
  | "commitment_fulfilled_after_followup"
  | "task_flagged_at_risk_by_planner"
  | "third_party_commitment_overdue"
  | "inferred_time_approved";

export interface ValueFigure {
  key: "commitments_saved" | "deadline_risks_flagged" | "hours_recovered";
  value: number | null;
  unit: "commitments" | "deadlines" | "hours";
  methods: ValueMethod[];
  estimated: boolean;
  sources: {
    type: string;
    id: string;
    label: string | null;
    method: ValueMethod;
    quantity: number;
    occurredAt: string;
  }[];
}

export interface ValueReport {
  period: "week" | "month";
  key: string;
  from: string;
  to: string;
  figures: ValueFigure[];
}

export interface ReviewItem {
  taskId: string;
  title: string;
  clientId: string | null;
}

export interface DailyReview {
  date: string;
  done: ReviewItem[];
  pending: ReviewItem[];
  toReschedule: ReviewItem[];
  blocked: ReviewItem[];
  newRisks: ReviewItem[];
  tomorrow: (ReviewItem & { startsAt: string })[];
}

export interface WeeklyReview {
  week: string;
  days: {
    day: string;
    capacityMinutes: number;
    plannedMinutes: number;
    completedMinutes: number;
    load: number | null;
  }[];
  totals: { capacityMinutes: number; plannedMinutes: number; completedMinutes: number };
  estimates: (ReviewItem & { estimateMinutes: number; actualMinutes: number; deltaPct: number })[];
  medianEstimateErrorPct: number | null;
  trend: {
    previousPlannedMinutes: number;
    previousCompletedMinutes: number;
    plannedDeltaPct: number | null;
  } | null;
}

export interface ClientStats {
  openCommitments: number;
  overdueCommitments: number;
  atRiskTasks: number;
  minutesApproved: number;
  minutesSuggested: number;
}

export interface Client {
  id: string;
  name: string;
  domains: string[];
  color: string | null;
  notes: string | null;
  verticalTags: string[];
  followupsMuted: boolean;
  archivedAt: string | null;
  createdAt: string;
  stats: ClientStats | null;
}

export interface ClientLinkPayload {
  domain: string;
  suggestedName: string;
  contacts: number;
  threads: number;
}

export interface BriefingItem {
  claim: string;
  kind: "pending" | "commitment" | "communication" | "decision" | "risk";
  sourceType: "task" | "commitment" | "thread" | "event";
  sourceId: string;
  sourceTitle: string | null;
  url: string | null;
}

export interface Briefing {
  clientId: string;
  clientName: string;
  eventId: string | null;
  source: "rules" | "ai";
  generatedAt: string;
  reused: boolean;
  items: BriefingItem[];
}

export interface TimeEntry {
  id: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  taskId: string | null;
  day: string;
  minutes: number;
  description: string | null;
  status: "suggested" | "approved" | "rejected" | "exported";
  sourceType: string;
  sourceId: string | null;
  approvedAt: string | null;
}

export interface TimeWeek {
  week: string;
  days: string[];
  items: TimeEntry[];
  summary: {
    clientId: string | null;
    clientName: string | null;
    minutesApproved: number;
    minutesSuggested: number;
  }[];
  unassignedEvents: { id: string; title: string | null; startsAt: string; endsAt: string; minutes: number }[];
}

export interface SearchHit {
  type: "task" | "commitment" | "client";
  id: string;
  title: string;
  clientId: string | null;
  status: string | null;
  date: string | null;
}
