/**
 * Planner contract. Pure and deterministic: no I/O, no randomness, no Date.now().
 * See docs/04-planner-engine.md.
 */
import { z } from "zod";

export const PlannerTask = z.object({
  id: z.string(),
  title: z.string(),
  clientId: z.string().nullable().default(null),
  priority: z.number().int().min(1).max(4),
  kind: z.enum(["deep", "shallow"]),
  estimateMinutes: z.number().int().positive(),
  remainingMinutes: z.number().int().nonnegative().optional(), // defaults to estimateMinutes
  dueAt: z.string().datetime().nullable(),          // ISO UTC
  deadlineType: z.enum(["soft", "hard"]).default("soft"),
  blockedBy: z.array(z.string()).default([]),
  status: z.enum(["pending", "scheduled", "in_progress", "blocked", "waiting_on_third_party", "at_risk", "completed"]),
});
export type PlannerTask = z.infer<typeof PlannerTask>;

export const FixedEvent = z.object({
  id: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  busy: z.boolean().default(true),
});
export type FixedEvent = z.infer<typeof FixedEvent>;

export const ExistingBlock = z.object({
  id: z.string(),
  taskId: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  pinned: z.boolean().default(false),
});
export type ExistingBlock = z.infer<typeof ExistingBlock>;

export const PlannerPreferences = z.object({
  timezone: z.string(),                       // IANA, e.g. "America/Santiago"
  workStart: z.string().regex(/^\d{2}:\d{2}$/),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/),
  workDays: z.array(z.number().int().min(0).max(6)),
  deepWorkWindows: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  minBlockMinutes: z.number().int().positive(),
  minDeepBlockMinutes: z.number().int().positive(),
  bufferMinutes: z.number().int().nonnegative(),
  contingencyPct: z.number().min(0).max(60),
  riskThresholdHours: z.number().nonnegative(),
});
export type PlannerPreferences = z.infer<typeof PlannerPreferences>;

export const PlanInput = z.object({
  now: z.string().datetime(),                 // injected clock
  horizonStart: z.string().datetime(),
  horizonEnd: z.string().datetime(),
  tasks: z.array(PlannerTask),
  fixedEvents: z.array(FixedEvent),
  existingBlocks: z.array(ExistingBlock).default([]),
  preferences: PlannerPreferences,
});
export type PlanInput = z.infer<typeof PlanInput>;

/** Structured, i18n-friendly explanation. The UI translates `code` + `params`. */
export interface Reason {
  code:
    | "DEADLINE_SLACK_LOW" | "DEADLINE_HARD" | "HIGH_PRIORITY" | "UNBLOCKS_OTHERS"
    | "DEEP_WORK_WINDOW" | "FILLS_GAP" | "PINNED_BY_USER" | "KEPT_STABLE" | "DEPENDENCY_ORDER";
  params: Record<string, string | number | boolean>;
}

export interface PlannedBlock {
  taskId: string;
  startsAt: string;
  endsAt: string;
  pinned: boolean;
  reasons: Reason[];
}

export type ConflictCode =
  | "CIRCULAR_DEPENDENCY" | "OVERLOAD" | "DEADLINE_INFEASIBLE" | "NO_CAPACITY" | "DEPENDENCY_AFTER_DEADLINE";

export interface Conflict {
  code: ConflictCode;
  taskIds: string[];
  details: Record<string, string | number>;
  alternatives: ("move_other_task" | "split_task" | "extend_deadline" | "delegate" | "reduce_scope")[];
}

export interface RiskItem {
  taskId: string;
  slackHours: number;
  cause: "LOW_SLACK" | "BLOCKED_DEPENDENCY" | "NO_CAPACITY";
}

export interface PlanDiff {
  added: PlannedBlock[];
  removed: { taskId: string; startsAt: string; endsAt: string }[];
  moved: { taskId: string; from: { startsAt: string; endsAt: string }; to: { startsAt: string; endsAt: string } }[];
}

export interface PlanResult {
  blocks: PlannedBlock[];
  unscheduled: { taskId: string; reason: ConflictCode | "BLOCKED" | "COMPLETED" }[];
  conflicts: Conflict[];
  risks: RiskItem[];
  diff: PlanDiff;
}
