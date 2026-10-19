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
