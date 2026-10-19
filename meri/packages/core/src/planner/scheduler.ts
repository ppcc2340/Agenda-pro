/**
 * Steps 3, 5, 6 and 7 of docs/04 wired together: tasks are processed in a
 * topological order where ready tasks go by score; each one is placed greedily,
 * deadline tasks first try to fit before their deadline, then limited
 * backtracking, then "as far as possible". A final fill pass brings the state to
 * a fixpoint (no pending work fits anywhere), which is what makes re-planning
 * with the output pinned idempotent.
 */
import type { Normalized, NormalizedTask } from "./normalize";
import { placeTask } from "./placement";
import { blocksOf, cloneState, finishOf, removeBlock, type ScheduledBlock, type ScheduleState } from "./schedule-state";
import { compareByScore, type ScoredTask } from "./scoring";
import { MAX_RELEASED_BLOCKS, releaseCandidates, remainingOf, shouldMoveKeptBlocks } from "./stability";
import type { Weights } from "./weights";

export interface TaskFacts {
  /** A dependency is unscheduled or only partially placed. */
  blocked: boolean;
  /** A dependency finishes after this task's deadline. */
  dependencyAfterDeadline: { dependencyId: string; finishesAt: number } | null;
}

export interface SchedulerContext {
  readonly n: Normalized;
  readonly weights: Weights;
  readonly scores: ReadonlyMap<string, ScoredTask>;
  readonly facts: Map<string, TaskFacts>;
  readonly processed: Set<string>;
  /**
   * Tasks that had a block released this run. Once backtracking has moved
   * anything, voluntary re-placements are disabled for the rest of the run so a
   * single re-plan never moves more than MAX_RELEASED_BLOCKS existing blocks.
   */
  readonly displaced: Set<string>;
}

type DependencyState =
  | { blocked: true }
  | { blocked: false; earliest: number; lastDependency: { dependencyId: string; finishesAt: number } | null };

function dependencyState(state: ScheduleState, n: Normalized, task: NormalizedTask): DependencyState {
  let earliest = n.now;
  let lastDependency: { dependencyId: string; finishesAt: number } | null = null;
  for (const depId of task.deps) {
    const dep = n.tasks.get(depId);
    if (dep === undefined || remainingOf(state, dep) > 0) return { blocked: true };
    const finish = finishOf(state, depId);
    if (finish === null) continue;
    const candidate = finish + n.preferences.bufferMinutes;
    if (candidate > earliest) {
      earliest = candidate;
      lastDependency = { dependencyId: depId, finishesAt: finish };
    }
  }
  return { blocked: false, earliest, lastDependency };
}

/** Deadline that bounds placement; deadlines beyond the horizon do not (the horizon does). */
export function effectiveDeadline(n: Normalized, task: NormalizedTask): number | null {
  return task.dueAt !== null && task.dueAt <= n.horizonEnd ? task.dueAt : null;
}

/** Topological order (Kahn) choosing the best-scored ready task at every step. */
export function processingOrder(ctx: SchedulerContext): NormalizedTask[] {
  const { n } = ctx;
  const indegree = new Map<string, number>();
  for (const task of n.tasks.values()) indegree.set(task.id, task.deps.length);
  const compare = compareByScore(ctx.scores);
  const order: NormalizedTask[] = [];
  let ready = [...n.tasks.values()].filter((t) => t.deps.length === 0);
  while (ready.length > 0) {
    ready.sort(compare);
    const [next, ...rest] = ready;
    if (next === undefined) break;
    ready = rest;
    order.push(next);
    for (const depId of next.dependents) {
      const left = (indegree.get(depId) ?? 0) - 1;
      indegree.set(depId, left);
      const dependent = n.tasks.get(depId);
      if (left === 0 && dependent !== undefined) ready.push(dependent);
    }
  }
  // Tasks never released depend (transitively) on a cycle: they end up BLOCKED.
  const seen = new Set(order.map((t) => t.id));
  for (const task of [...n.tasks.values()].sort(compare)) if (!seen.has(task.id)) order.push(task);
  return order;
}

function commitState(target: ScheduleState, source: ScheduleState): void {
  target.blocks = source.blocks;
  source.days.forEach((day, i) => {
    const t = target.days[i];
    if (t === undefined) return;
    t.free = day.free;
    t.assigned = day.assigned;
  });
}

/**
 * Limited backtracking: release up to MAX_RELEASED_BLOCKS lower-scored blocks
 * before the deadline until the task fits; on failure nothing changes.
 * Released tasks that were already processed are re-placed right away.
 */
function tryWithReleases(ctx: SchedulerContext, state: ScheduleState, task: NormalizedTask, earliest: number, deadline: number): boolean {
  const trial = cloneState(state);
  const released: ScheduledBlock[] = [];
  while (released.length < MAX_RELEASED_BLOCKS) {
    const candidate = releaseCandidates(trial, ctx.n, ctx.scores, task, deadline)[0];
    if (candidate === undefined) return false;
    removeBlock(trial, ctx.n, candidate);
    released.push(candidate);
    const probe = cloneState(trial);
    const result = placeTask(probe, ctx.n, { task, remaining: remainingOf(probe, task), earliest, deadline });
    if (result.unplaced > 0) continue;
    commitState(state, probe);
    for (const b of released) ctx.displaced.add(b.taskId);
    const toReplace = [...new Set(released.map((b) => b.taskId))]
      .map((id) => ctx.n.tasks.get(id))
      .filter((t): t is NormalizedTask => t !== undefined && ctx.processed.has(t.id))
      .sort(compareByScore(ctx.scores));
    for (const other of toReplace) placeOne(ctx, state, other, "fill");
    return true;
  }
  return false;
}

/**
 * Places one task's remaining work. The "initial" mode (first visit) may move
 * kept blocks and backtrack; "fill" (re-placements, fixpoint pass) only adds.
 */
function placeOne(ctx: SchedulerContext, state: ScheduleState, task: NormalizedTask, mode: "initial" | "fill"): void {
  const { n } = ctx;
  const facts: TaskFacts = { blocked: false, dependencyAfterDeadline: null };
  ctx.facts.set(task.id, facts);
  const deps = dependencyState(state, n, task);
  if (deps.blocked) {
    facts.blocked = true;
    return;
  }
  const mayMove = mode === "initial" && ctx.displaced.size === 0;
  if (mayMove && shouldMoveKeptBlocks(state, n, task, deps.earliest, ctx.weights)) {
    for (const b of blocksOf(state, task.id).filter((x) => x.kept)) removeBlock(state, n, b);
  }
  const remaining = remainingOf(state, task);
  if (remaining === 0) return;
  const deadline = effectiveDeadline(n, task);
  if (deadline === null) {
    placeTask(state, n, { task, remaining, earliest: deps.earliest, deadline: null });
    return;
  }
  if (deps.earliest >= deadline && deps.lastDependency !== null) {
    facts.dependencyAfterDeadline = deps.lastDependency;
  } else {
    const trial = cloneState(state);
    const result = placeTask(trial, n, { task, remaining, earliest: deps.earliest, deadline });
    if (result.unplaced === 0) {
      commitState(state, trial);
      return;
    }
    if (mode === "initial" && tryWithReleases(ctx, state, task, deps.earliest, deadline)) return;
    // Infeasible: place as much as possible before the deadline...
    placeTask(state, n, { task, remaining, earliest: deps.earliest, deadline });
  }
  // ...and, for soft deadlines, the rest afterwards so the work is still visible.
  if (task.deadlineType === "soft") {
    placeTask(state, n, { task, remaining: remainingOf(state, task), earliest: deps.earliest, deadline: null });
  }
}

/**
 * Fixpoint pass: keeps placing pending work (and unblocking tasks whose
 * dependencies completed through backtracking) until nothing more fits.
 */
function fillToFixpoint(ctx: SchedulerContext, state: ScheduleState, order: readonly NormalizedTask[]): void {
  let progress = true;
  while (progress) {
    progress = false;
    for (const task of order) {
      if (remainingOf(state, task) === 0) continue;
      const before = state.blocks.length;
      placeOne(ctx, state, task, "fill");
      if (state.blocks.length !== before) progress = true;
    }
  }
}

/** Runs the greedy loop over every schedulable task, mutating `state`. */
export function scheduleAll(ctx: SchedulerContext, state: ScheduleState, order: readonly NormalizedTask[]): void {
  for (const task of order) {
    placeOne(ctx, state, task, "initial");
    ctx.processed.add(task.id);
  }
  fillToFixpoint(ctx, state, order);
}
