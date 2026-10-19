/**
 * docs/04 "Cálculo de riesgo": a task is at risk when its slack is below the
 * threshold, when it is blocked by a dependency and its deadline is inside the
 * horizon, or when there is no assignable capacity for it before the deadline.
 * Slack is measured in work hours (capacity after contingency) between the
 * planned finish and the deadline, so the user reads it as "margin to absorb
 * overruns".
 */
import { grossCapacityBetween } from "./capacity";
import type { NormalizedTask } from "./normalize";
import { blocksOf, finishOf, type ScheduleState } from "./schedule-state";
import type { SchedulerContext } from "./scheduler";
import { remainingOf } from "./stability";
import type { RiskItem } from "./types";

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Work hours of margin between the task's planned finish and its deadline `dueAt`. */
export function slackHoursFor(
  ctx: SchedulerContext,
  state: ScheduleState,
  task: NormalizedTask,
  dueAt: number,
): number {
  const { n } = ctx;
  const capacity = (from: number, to: number): number =>
    grossCapacityBetween(state.days, n.preferences, from, to) / 60;
  if (remainingOf(state, task) > 0) return round2(capacity(n.now, dueAt) - task.remaining / 60);
  const finish = finishOf(state, task.id) ?? n.now;
  return round2(finish <= dueAt ? capacity(finish, dueAt) : -capacity(dueAt, finish));
}

export function computeRisks(ctx: SchedulerContext, state: ScheduleState): RiskItem[] {
  const { n } = ctx;
  const risks: RiskItem[] = [];
  for (const task of [...n.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.dueAt === null) continue;
    const slackHours = slackHoursFor(ctx, state, task, task.dueAt);
    const facts = ctx.facts.get(task.id);
    if (facts?.blocked === true && blocksOf(state, task.id).length === 0) {
      if (task.dueAt <= n.horizonEnd)
        risks.push({ taskId: task.id, slackHours, cause: "BLOCKED_DEPENDENCY" });
      continue;
    }
    if (remainingOf(state, task) > 0) {
      risks.push({ taskId: task.id, slackHours, cause: "NO_CAPACITY" });
      continue;
    }
    if (slackHours < n.preferences.riskThresholdHours)
      risks.push({ taskId: task.id, slackHours, cause: "LOW_SLACK" });
  }
  return risks;
}
