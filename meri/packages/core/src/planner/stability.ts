/**
 * Step 7 of docs/04: re-planning must not make the calendar "tremble".
 * - Pinned blocks are immovable and taken as-is.
 * - Non-pinned existing blocks are kept when they are still valid under every
 *   hard constraint, and re-placed only when a fresh placement is clearly better
 *   (finishes more than `movementPenalty` hours earlier per moved block, or
 *   meets a deadline the kept placement misses).
 * - A deadline task may release at most MAX_RELEASED_BLOCKS blocks of
 *   lower-scored tasks (limited backtracking); higher-scored work is never
 *   displaced. Voluntary re-placements stop once any release happened, so one
 *   re-plan moves at most MAX_RELEASED_BLOCKS existing blocks when the input
 *   change is adding a task (property 7 of docs/04).
 */
import type { Normalized, NormalizedTask } from "./normalize";
import { placeTask } from "./placement";
import {
  addBlock,
  assignedMinutes,
  blocksOf,
  dayIndexAt,
  finishOf,
  fitsInFree,
  removeBlock,
  type ScheduledBlock,
  type ScheduleState,
} from "./schedule-state";
import type { ScoredTask } from "./scoring";
import type { Weights } from "./weights";

/** Upper bound on blocks a single deadline task may displace when re-planning. */
export const MAX_RELEASED_BLOCKS = 3;

export function remainingOf(state: ScheduleState, task: NormalizedTask): number {
  return Math.max(0, task.remaining - assignedMinutes(state, task.id));
}

/** Transitive dependencies of a task (ids). */
export function ancestorsOf(n: Normalized, taskId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(n.tasks.get(taskId)?.deps ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(n.tasks.get(id)?.deps ?? []));
  }
  return seen;
}

function descendantHasBlocks(state: ScheduleState, n: Normalized, taskId: string): boolean {
  const seen = new Set<string>();
  const stack = [...(n.tasks.get(taskId)?.dependents ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (blocksOf(state, id).length > 0) return true;
    stack.push(...(n.tasks.get(id)?.dependents ?? []));
  }
  return false;
}

/** Pinned blocks of schedulable tasks go into the state untouched. */
export function addPinnedBlocks(state: ScheduleState, n: Normalized): void {
  const pinned = n.existingBlocks.filter((b) => b.pinned && n.tasks.has(b.taskId));
  for (const b of pinned.sort((x, y) => x.start - y.start || x.id.localeCompare(y.id))) {
    addBlock(state, n, {
      sourceId: b.id,
      taskId: b.taskId,
      start: b.start,
      end: b.end,
      pinned: true,
      kept: false,
      dayIndex: dayIndexAt(state, n, b.start),
      inDeepWindow: false,
      gapMinutes: null,
    });
  }
}

/** Latest finish (+buffer) of the task's dependencies when all are fully placed; null otherwise. */
function dependenciesFinish(state: ScheduleState, n: Normalized, task: NormalizedTask): number | null {
  let earliest = n.now;
  for (const depId of task.deps) {
    const dep = n.tasks.get(depId);
    if (dep === undefined || remainingOf(state, dep) > 0) return null;
    const finish = finishOf(state, depId);
    if (finish !== null) earliest = Math.max(earliest, finish + n.preferences.bufferMinutes);
  }
  return earliest;
}

/**
 * Keeps every non-pinned existing block that still satisfies the hard
 * constraints (work hours, fixed events, `now`, capacity, dependencies and the
 * task's remaining work). `order` must be topological so dependencies are
 * validated before dependents.
 */
export function keepValidBlocks(state: ScheduleState, n: Normalized, order: readonly NormalizedTask[]): void {
  for (const task of order) {
    const earliest = dependenciesFinish(state, n, task);
    const own = n.existingBlocks
      .filter((b) => !b.pinned && b.taskId === task.id)
      .sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
    for (const b of own) {
      const dayIndex = dayIndexAt(state, n, b.start);
      const day = state.days[dayIndex];
      const duration = b.end - b.start;
      const valid =
        earliest !== null &&
        day !== undefined &&
        b.start >= earliest &&
        fitsInFree(day, b.start, b.end) &&
        day.assigned + duration <= day.capacity &&
        duration <= remainingOf(state, task);
      if (!valid) continue;
      const inDeepWindow = day.deepWindows.some((w) => w.start <= b.start && b.end <= w.end);
      addBlock(state, n, {
        sourceId: b.id,
        taskId: task.id,
        start: b.start,
        end: b.end,
        pinned: false,
        kept: true,
        dayIndex,
        inDeepWindow,
        gapMinutes: null,
      });
    }
  }
}

/**
 * Decides whether the task's kept blocks should be released and re-placed.
 * Compares "keep + place the rest" against "place everything fresh".
 */
export function shouldMoveKeptBlocks(
  state: ScheduleState,
  n: Normalized,
  task: NormalizedTask,
  earliest: number,
  weights: Weights,
): boolean {
  const kept = blocksOf(state, task.id).filter((b) => b.kept);
  if (kept.length === 0) return false;
  // Alternative A: keep the blocks and place only the rest.
  const keepResult = placeTask(state, n, { task, remaining: remainingOf(state, task), earliest, deadline: null });
  const keepFinish = finishOf(state, task.id) ?? n.horizonEnd;
  for (const b of keepResult.placed) removeBlock(state, n, b);
  // Alternative B: release the kept blocks and place everything fresh.
  for (const b of kept) removeBlock(state, n, b);
  const freshResult = placeTask(state, n, { task, remaining: remainingOf(state, task), earliest, deadline: null });
  const freshFinish = finishOf(state, task.id) ?? n.horizonEnd;
  for (const b of freshResult.placed) removeBlock(state, n, b);
  for (const b of kept) addBlock(state, n, b);
  if (freshResult.unplaced > keepResult.unplaced) return false;
  if (task.dueAt !== null && keepFinish > task.dueAt && freshFinish <= task.dueAt) return true;
  const gainHours = (keepFinish - freshFinish) / 60;
  return gainHours > weights.movementPenalty * kept.length;
}

/**
 * Blocks a deadline task may displace: non-pinned blocks of lower-scored tasks
 * that start before the deadline, excluding its own dependencies and tasks whose
 * dependents already have blocks (moving those would break dependency order).
 * Lowest score first, then latest start (blocks never share a start, so the
 * order is total), so the cheapest commitments go first.
 */
export function releaseCandidates(
  state: ScheduleState,
  n: Normalized,
  scores: ReadonlyMap<string, ScoredTask>,
  task: NormalizedTask,
  deadline: number,
): ScheduledBlock[] {
  const ownScore = scores.get(task.id)?.score ?? 0;
  const ancestors = ancestorsOf(n, task.id);
  const scoreOf = (id: string): number => scores.get(id)?.score ?? 0;
  return state.blocks
    .filter(
      (b) =>
        !b.pinned &&
        b.taskId !== task.id &&
        b.start < deadline &&
        scoreOf(b.taskId) < ownScore &&
        !ancestors.has(b.taskId) &&
        !descendantHasBlocks(state, n, b.taskId),
    )
    .sort((x, y) => scoreOf(x.taskId) - scoreOf(y.taskId) || y.start - x.start);
}
