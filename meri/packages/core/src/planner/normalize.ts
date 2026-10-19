/**
 * Step 1 of docs/04: validate the raw input with Zod, convert instants to epoch
 * minutes, resolve dependency edges and detect circular dependencies.
 */
import {
  isValidTimeZone,
  isoToMinutes,
  parseWallTime,
  wallToMinutes,
  type WallTime,
} from "./calendar-math";
import { PlanInput, type ExistingBlock, type PlannerTask } from "./types";

export class PlannerInputError extends Error {
  readonly code = "INVALID_PLAN_INPUT";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid plan input: ${issues.join("; ")}`);
    this.name = "PlannerInputError";
    this.issues = issues;
  }
}

export interface NormalizedTask {
  readonly id: string;
  readonly priority: number;
  readonly kind: "deep" | "shallow";
  /** Minutes still to plan (remainingMinutes ?? estimateMinutes). */
  readonly remaining: number;
  readonly dueAt: number | null;
  readonly deadlineType: "soft" | "hard";
  /** Known, non-completed dependencies (unknown or completed ids are already satisfied). */
  readonly deps: readonly string[];
  readonly dependents: readonly string[];
}

export interface NormalizedEvent {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface NormalizedExistingBlock {
  readonly id: string;
  readonly taskId: string;
  readonly start: number;
  readonly end: number;
  readonly pinned: boolean;
}

export interface NormalizedPreferences {
  readonly timezone: string;
  readonly workStart: WallTime;
  readonly workEnd: WallTime;
  readonly workDays: ReadonlySet<number>;
  readonly deepWorkWindows: readonly { start: WallTime; end: WallTime }[];
  readonly minBlockMinutes: number;
  readonly minDeepBlockMinutes: number;
  readonly bufferMinutes: number;
  readonly contingencyPct: number;
  readonly riskThresholdHours: number;
}

export interface Normalized {
  readonly now: number;
  readonly horizonStart: number;
  readonly horizonEnd: number;
  readonly preferences: NormalizedPreferences;
  /** Schedulable tasks (not completed, not in a cycle), keyed by id. */
  readonly tasks: ReadonlyMap<string, NormalizedTask>;
  readonly completedIds: readonly string[];
  readonly cycleIds: readonly string[];
  /** Busy fixed events only; free events never constrain the plan. */
  readonly fixedEvents: readonly NormalizedEvent[];
  readonly existingBlocks: readonly NormalizedExistingBlock[];
}

function parseInput(raw: unknown): PlanInput {
  const parsed = PlanInput.safeParse(raw);
  if (!parsed.success) {
    throw new PlannerInputError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    );
  }
  return parsed.data;
}

function normalizePreferences(input: PlanInput, issues: string[]): NormalizedPreferences {
  const p = input.preferences;
  const workStart = parseWallTime(p.workStart) ?? { hour: 0, minute: 0 };
  const workEnd = parseWallTime(p.workEnd) ?? { hour: 0, minute: 0 };
  if (!isValidTimeZone(p.timezone)) issues.push(`preferences.timezone: unknown IANA zone "${p.timezone}"`);
  if (parseWallTime(p.workStart) === null) issues.push("preferences.workStart: expected HH:MM");
  if (parseWallTime(p.workEnd) === null) issues.push("preferences.workEnd: expected HH:MM");
  if (wallToMinutes(workStart) >= wallToMinutes(workEnd)) {
    issues.push("preferences.workStart must be before workEnd");
  }
  const deepWorkWindows: { start: WallTime; end: WallTime }[] = [];
  p.deepWorkWindows.forEach((w, index) => {
    const start = parseWallTime(w.start);
    const end = parseWallTime(w.end);
    if (start === null || end === null || wallToMinutes(start) >= wallToMinutes(end)) {
      issues.push(`preferences.deepWorkWindows.${String(index)}: expected HH:MM range with start < end`);
      return;
    }
    deepWorkWindows.push({ start, end });
  });
  return {
    timezone: p.timezone,
    workStart,
    workEnd,
    workDays: new Set(p.workDays),
    deepWorkWindows,
    minBlockMinutes: p.minBlockMinutes,
    minDeepBlockMinutes: p.minDeepBlockMinutes,
    bufferMinutes: p.bufferMinutes,
    contingencyPct: p.contingencyPct,
    riskThresholdHours: p.riskThresholdHours,
  };
}

/**
 * Ids of tasks that belong to a dependency cycle (an SCC with a back edge).
 * Tasks merely downstream of a cycle are not circular themselves: they end up
 * BLOCKED because their dependency is unscheduled.
 */
export function findCycleMembers(tasks: readonly Pick<PlannerTask, "id" | "blockedBy">[]): Set<string> {
  const ids = new Set(tasks.map((t) => t.id));
  const dependentsOf = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.blockedBy) {
      if (!ids.has(dep)) continue;
      const list = dependentsOf.get(dep) ?? [];
      list.push(task.id);
      dependentsOf.set(dep, list);
    }
  }
  const members = new Set<string>();
  for (const task of tasks) {
    // A task is circular iff it can reach itself following "unblocks" edges.
    const seen = new Set<string>();
    const stack = [...(dependentsOf.get(task.id) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      if (current === task.id) {
        members.add(task.id);
        break;
      }
      seen.add(current);
      stack.push(...(dependentsOf.get(current) ?? []));
    }
  }
  return members;
}

function normalizeTasks(input: PlanInput, issues: string[]): Pick<Normalized, "tasks" | "completedIds" | "cycleIds"> {
  const seen = new Set<string>();
  for (const task of input.tasks) {
    if (seen.has(task.id)) issues.push(`tasks: duplicate id "${task.id}"`);
    seen.add(task.id);
  }
  const completedIds = input.tasks.filter((t) => t.status === "completed").map((t) => t.id);
  const open = input.tasks.filter((t) => t.status !== "completed");
  const openIds = new Set(open.map((t) => t.id));
  const cycle = findCycleMembers(open);
  const schedulable = open.filter((t) => !cycle.has(t.id));
  const dependents = new Map<string, string[]>();
  const deps = new Map<string, string[]>();
  for (const task of schedulable) {
    // Dependencies on unknown, completed or circular tasks: unknown/completed are
    // satisfied; circular ones stay as deps so the dependent becomes BLOCKED.
    const own = task.blockedBy.filter((d) => d !== task.id && openIds.has(d));
    deps.set(task.id, own);
    for (const d of own) {
      const list = dependents.get(d) ?? [];
      list.push(task.id);
      dependents.set(d, list);
    }
  }
  const tasks = new Map<string, NormalizedTask>();
  for (const task of schedulable) {
    tasks.set(task.id, {
      id: task.id,
      priority: task.priority,
      kind: task.kind,
      remaining: task.remainingMinutes ?? task.estimateMinutes,
      dueAt: task.dueAt === null ? null : isoToMinutes(task.dueAt, "floor"),
      deadlineType: task.deadlineType,
      deps: deps.get(task.id) ?? [],
      dependents: dependents.get(task.id) ?? [],
    });
  }
  return { tasks, completedIds, cycleIds: [...cycle].sort() };
}

function normalizeBlocks(blocks: readonly ExistingBlock[], issues: string[]): NormalizedExistingBlock[] {
  return blocks.map((b, index) => {
    const start = isoToMinutes(b.startsAt, "floor");
    const end = isoToMinutes(b.endsAt, "ceil");
    if (start >= end) issues.push(`existingBlocks.${String(index)}: startsAt must be before endsAt`);
    return { id: b.id, taskId: b.taskId, start, end, pinned: b.pinned };
  });
}

/** Validates and converts the raw input; throws PlannerInputError on any issue. */
export function normalize(raw: unknown): Normalized {
  const input = parseInput(raw);
  const issues: string[] = [];
  const now = isoToMinutes(input.now, "ceil");
  const horizonStart = isoToMinutes(input.horizonStart, "floor");
  const horizonEnd = isoToMinutes(input.horizonEnd, "floor");
  if (horizonStart >= horizonEnd) issues.push("horizonStart must be before horizonEnd");
  const preferences = normalizePreferences(input, issues);
  const taskParts = normalizeTasks(input, issues);
  const fixedEvents = input.fixedEvents
    .filter((e) => e.busy)
    .map((e) => ({ id: e.id, start: isoToMinutes(e.startsAt, "floor"), end: isoToMinutes(e.endsAt, "ceil") }));
  input.fixedEvents.forEach((e, index) => {
    if (Date.parse(e.startsAt) > Date.parse(e.endsAt)) {
      issues.push(`fixedEvents.${String(index)}: startsAt must not be after endsAt`);
    }
  });
  const existingBlocks = normalizeBlocks(input.existingBlocks, issues);
  if (issues.length > 0) throw new PlannerInputError(issues);
  return { now, horizonStart, horizonEnd, preferences, ...taskParts, fixedEvents, existingBlocks };
}
