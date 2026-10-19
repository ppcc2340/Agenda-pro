/**
 * Step 8 of docs/04: every block carries structured reasons that the UI
 * translates. Reasons are derived after placement so they reflect the final
 * plan (e.g. the slack actually obtained), not an intermediate state.
 */
import { minutesToIso } from "./calendar-math";
import type { NormalizedTask } from "./normalize";
import type { ScheduledBlock } from "./schedule-state";
import type { SchedulerContext } from "./scheduler";
import type { Reason } from "./types";

/** P1 and P2 are what users call "high priority". */
const HIGH_PRIORITY_MAX = 2;

export function buildReasons(
  ctx: SchedulerContext,
  block: ScheduledBlock,
  task: NormalizedTask,
  slackHours: number | null,
): Reason[] {
  const reasons: Reason[] = [];
  if (block.pinned) reasons.push({ code: "PINNED_BY_USER", params: { blockId: block.sourceId ?? "" } });
  if (block.kept) reasons.push({ code: "KEPT_STABLE", params: { blockId: block.sourceId ?? "" } });
  if (task.dueAt !== null) {
    const dueAt = minutesToIso(task.dueAt);
    if (task.deadlineType === "hard") reasons.push({ code: "DEADLINE_HARD", params: { dueAt } });
    if (slackHours !== null && slackHours < ctx.n.preferences.riskThresholdHours) {
      reasons.push({ code: "DEADLINE_SLACK_LOW", params: { dueAt, slackHours } });
    }
  }
  if (task.priority <= HIGH_PRIORITY_MAX) reasons.push({ code: "HIGH_PRIORITY", params: { priority: task.priority } });
  const descendants = ctx.scores.get(task.id)?.descendants ?? 0;
  if (descendants > 0) reasons.push({ code: "UNBLOCKS_OTHERS", params: { count: descendants } });
  if (block.inDeepWindow) reasons.push({ code: "DEEP_WORK_WINDOW", params: { kind: task.kind } });
  if (block.gapMinutes !== null) reasons.push({ code: "FILLS_GAP", params: { gapMinutes: block.gapMinutes } });
  if (task.deps.length > 0) reasons.push({ code: "DEPENDENCY_ORDER", params: { after: [...task.deps].sort().join(",") } });
  return reasons;
}
