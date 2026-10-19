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
  kind: "digest" | "risk" | "proposals" | "plan" | "integration";
  title: string;
  body: string;
  template: string;
  params: Record<string, string | number>;
  refs: { type: string; id: string }[];
  day: string;
  readAt: string | null;
  createdAt: string;
}
