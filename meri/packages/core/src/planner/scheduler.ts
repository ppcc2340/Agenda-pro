/**
 * Steps 3, 5, 6 and 7 of docs/04 wired together: tasks are processed in a
 * topological order where ready tasks go by score; each one is placed greedily,
 * deadline tasks first try to fit before their deadline, then limited
 * backtracking, then "as far as possible". A final fill pass brings the state to
 * a fixpoint (no pending work fits anywhere), which is what makes re-planning
 * with the output pinned idempotent.
 *
 * Trials run on the real state and are undone block by block: the free space of
 * a day is always recomputed from its base windows, so undo is exact.
 */
import type { Normalized, NormalizedTask } from "./normalize";
import { placeTask } from "./placement";
import {
  addBlock,
  blocksOf,
  finishOf,
  removeBlock,
  type ScheduledBlock,
  type ScheduleState,
} from "./schedule-state";
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
   * anything, voluntary re-placements are disabled for the rest of the run.
   */
  readonly displaced: Set<string>;
  /**
   * How many previously accepted (kept) blocks may still be displaced in this
   * run. Together with `displaced` it bounds a re-plan to MAX_RELEASED_BLOCKS
   * moved existing blocks, even when releases cascade through dependencies.
   */
  readonly budget: { keptReleases: number };
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

/**
 * Topological order choosing the best-scored ready task at every step. Tasks
 * that never become ready depend (transitively) on a cycle and go last; they
 * end up BLOCKED.
 */
export function processingOrder(ctx: SchedulerContext): NormalizedTask[] {
  const compare = compareByScore(ctx.scores);
  const done = new Set<string>();
  const order: NormalizedTask[] = [];
  let pending = [...ctx.n.tasks.values()];
  while (pending.length > 0) {
    const next = pending.filter((t) => t.deps.every((d) => done.has(d))).sort(compare)[0];
    if (next === undefined) break;
    done.add(next.id);
    order.push(next);
    pending = pending.filter((t) => t !== next);
  }
  return [...order, ...pending.sort(compare)];
}

/** Places before `deadline` and keeps the result only when everything fits. */
function tryPlaceBeforeDeadline(
  state: ScheduleState,
  n: Normalized,
  task: NormalizedTask,
  earliest: number,
  deadline: number,
): boolean {
  const result = placeTask(state, n, { task, remaining: remainingOf(state, task), earliest, deadline });
  if (result.unplaced === 0) return true;
  for (const b of result.placed) removeBlock(state, n, b);
  return false;
}

/**
 * Limited backtracking: release up to MAX_RELEASED_BLOCKS lower-scored blocks
 * before the deadline (kept blocks only while the run's budget allows) until
 * the task fits; on failure the releases are undone. Released tasks that were
 * already processed are re-placed right away.
 */
function tryWithReleases(
  ctx: SchedulerContext,
  state: ScheduleState,
  task: NormalizedTask,
  earliest: number,
  deadline: number,
): boolean {
  const released: ScheduledBlock[] = [];
  const keptReleased = (): number => released.filter((b) => b.kept).length;
  while (released.length < MAX_RELEASED_BLOCKS) {
    const candidate = releaseCandidates(state, ctx.n, ctx.scores, task, deadline).find(
      (b) => !b.kept || keptReleased() < ctx.budget.keptReleases,
    );
    if (candidate === undefined) break;
    removeBlock(state, ctx.n, candidate);
    released.push(candidate);
    if (!tryPlaceBeforeDeadline(state, ctx.n, task, earliest, deadline)) continue;
    ctx.budget.keptReleases -= keptReleased();
    for (const b of released) ctx.displaced.add(b.taskId);
    const toReplace = [...new Set(released.map((b) => b.taskId))]
      .map((id) => ctx.n.tasks.get(id))
      .filter((t): t is NormalizedTask => t !== undefined && ctx.processed.has(t.id))
      .sort(compareByScore(ctx.scores));
    for (const other of toReplace) placeOne(ctx, state, other, "fill");
    return true;
  }
  for (const b of released) addBlock(state, ctx.n, b);
  return false;
}

/**
 * Places one task's remaining work. The "initial" mode (first visit) may move
 * kept blocks and backtrack; "fill" (re-placements, fixpoint pass) only adds.
 */
function placeOne(
  ctx: SchedulerContext,
  state: ScheduleState,
  task: NormalizedTask,
  mode: "initial" | "fill",
): void {
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
    if (tryPlaceBeforeDeadline(state, n, task, deps.earliest, deadline)) return;
    if (mode === "initial" && tryWithReleases(ctx, state, task, deps.earliest, deadline)) return;
    // Infeasible: place as much as possible before the deadline...
    placeTask(state, n, { task, remaining, earliest: deps.earliest, deadline });
  }
  // ...and, for soft deadlines, the rest afterwards so the work is still visible.
  if (task.deadlineType === "soft") {
    placeTask(state, n, {
      task,
      remaining: remainingOf(state, task),
      earliest: deps.earliest,
      deadline: null,
    });
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
export function scheduleAll(
  ctx: SchedulerContext,
  state: ScheduleState,
  order: readonly NormalizedTask[],
): void {
  for (const task of order) {
    placeOne(ctx, state, task, "initial");
    ctx.processed.add(task.id);
  }
  fillToFixpoint(ctx, state, order);
}
