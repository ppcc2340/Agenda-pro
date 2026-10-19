/**
 * Deterministic planner entry point (docs/04-planner-engine.md, algorithm v1).
 * Pure: everything, including the clock, comes from `input`.
 */
import { minutesToIso } from "./calendar-math";
import { computeDiff } from "./diff";
import { deriveFeasibility } from "./feasibility";
import { normalize } from "./normalize";
import { buildReasons } from "./reasons";
import { computeRisks, slackHoursOf } from "./risks";
import { createState, type ScheduleState } from "./schedule-state";
import { processingOrder, scheduleAll, type SchedulerContext } from "./scheduler";
import { scoreTasks } from "./scoring";
import { addPinnedBlocks, keepValidBlocks } from "./stability";
import type { PlanInput, PlannedBlock, PlanResult } from "./types";
import { DEFAULT_WEIGHTS, type Weights } from "./weights";

function toPlannedBlocks(ctx: SchedulerContext, state: ScheduleState): PlannedBlock[] {
  const slackByTask = new Map<string, number | null>();
  for (const task of ctx.n.tasks.values()) slackByTask.set(task.id, slackHoursOf(ctx, state, task));
  const blocks: PlannedBlock[] = [];
  for (const block of state.blocks) {
    const task = ctx.n.tasks.get(block.taskId);
    if (task === undefined) continue;
    blocks.push({
      taskId: block.taskId,
      startsAt: minutesToIso(block.start),
      endsAt: minutesToIso(block.end),
      pinned: block.pinned,
      reasons: buildReasons(ctx, block, task, slackByTask.get(task.id) ?? null),
    });
  }
  return blocks.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.taskId.localeCompare(b.taskId));
}

/**
 * 1. normalize (Zod + cycles) → 2. capacity per day → 3./4. score and order →
 * pinned + kept blocks → 5.–7. greedy placement with limited backtracking and
 * stability → 6. feasibility → risks → 8. reasons → diff.
 * Throws PlannerInputError on invalid input.
 */
export function plan(input: PlanInput, weights: Weights = DEFAULT_WEIGHTS): PlanResult {
  const n = normalize(input);
  const state = createState(n);
  const ctx: SchedulerContext = {
    n,
    weights,
    scores: scoreTasks(n, state.days, weights),
    facts: new Map(),
    processed: new Set(),
    displaced: new Set(),
  };
  const order = processingOrder(ctx);
  addPinnedBlocks(state, n);
  keepValidBlocks(state, n, order);
  scheduleAll(ctx, state, order);
  const blocks = toPlannedBlocks(ctx, state);
  const { unscheduled, conflicts } = deriveFeasibility(ctx, state);
  return {
    blocks,
    unscheduled,
    conflicts,
    risks: computeRisks(ctx, state),
    diff: computeDiff(n.existingBlocks, blocks),
  };
}
