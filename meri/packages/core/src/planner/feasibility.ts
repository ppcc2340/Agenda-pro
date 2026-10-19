/**
 * Step 6 of docs/04: derive conflicts and the unscheduled list from the final
 * state. Conflicts are computed at the end (not while placing) so that limited
 * backtracking and the fill pass cannot leave stale verdicts behind.
 */
import { grossCapacityBetween } from "./capacity";
import { minutesToIso } from "./calendar-math";
import type { NormalizedTask } from "./normalize";
import { blocksOf, finishOf, type ScheduleState } from "./schedule-state";
import { effectiveDeadline, type SchedulerContext } from "./scheduler";
import { remainingOf } from "./stability";
import type { Conflict, PlanResult } from "./types";

type Unscheduled = PlanResult["unscheduled"][number];

export interface Feasibility {
  unscheduled: Unscheduled[];
  conflicts: Conflict[];
}

function deadlineConflict(ctx: SchedulerContext, state: ScheduleState, task: NormalizedTask, deadline: number): Conflict {
  const { n } = ctx;
  const finish = finishOf(state, task.id);
  const unplaced = remainingOf(state, task);
  const noCapacity = grossCapacityBetween(state.days, n.preferences, n.now, deadline) === 0;
  const othersBeforeDeadline = state.blocks.some((b) => !b.pinned && b.taskId !== task.id && b.start < deadline);
  const alternatives: Conflict["alternatives"] = [];
  if (!noCapacity && othersBeforeDeadline) alternatives.push("move_other_task");
  if (!noCapacity && task.remaining > n.preferences.minBlockMinutes) alternatives.push("split_task");
  alternatives.push("extend_deadline", "delegate", "reduce_scope");
  return {
    code: noCapacity ? "NO_CAPACITY" : "DEADLINE_INFEASIBLE",
    taskIds: [task.id],
    details: {
      dueAt: minutesToIso(deadline),
      deadlineType: task.deadlineType,
      placedMinutes: task.remaining - unplaced,
      unplacedMinutes: unplaced,
      lateMinutes: finish !== null && finish > deadline ? finish - deadline : 0,
    },
    alternatives,
  };
}

function compareConflicts(a: Conflict, b: Conflict): number {
  return a.code.localeCompare(b.code) || (a.taskIds[0] ?? "").localeCompare(b.taskIds[0] ?? "");
}

export function deriveFeasibility(ctx: SchedulerContext, state: ScheduleState): Feasibility {
  const { n } = ctx;
  const unscheduled: Unscheduled[] = [];
  const conflicts: Conflict[] = [];
  for (const id of n.completedIds) unscheduled.push({ taskId: id, reason: "COMPLETED" });
  for (const id of n.cycleIds) unscheduled.push({ taskId: id, reason: "CIRCULAR_DEPENDENCY" });
  if (n.cycleIds.length > 0) {
    conflicts.push({
      code: "CIRCULAR_DEPENDENCY",
      taskIds: [...n.cycleIds],
      details: { count: n.cycleIds.length },
      alternatives: [],
    });
  }
  const overloaded: NormalizedTask[] = [];
  for (const task of [...n.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const facts = ctx.facts.get(task.id) ?? { blocked: false, dependencyAfterDeadline: null };
    const hasBlocks = blocksOf(state, task.id).length > 0;
    const unplaced = remainingOf(state, task);
    if (facts.blocked) {
      if (!hasBlocks) unscheduled.push({ taskId: task.id, reason: "BLOCKED" });
      continue;
    }
    if (facts.dependencyAfterDeadline !== null && task.dueAt !== null) {
      conflicts.push({
        code: "DEPENDENCY_AFTER_DEADLINE",
        taskIds: [task.id, facts.dependencyAfterDeadline.dependencyId],
        details: {
          dueAt: minutesToIso(task.dueAt),
          dependencyId: facts.dependencyAfterDeadline.dependencyId,
          dependencyFinishesAt: minutesToIso(facts.dependencyAfterDeadline.finishesAt),
        },
        alternatives: ["move_other_task", "extend_deadline", "delegate"],
      });
      if (!hasBlocks) unscheduled.push({ taskId: task.id, reason: "DEPENDENCY_AFTER_DEADLINE" });
      continue;
    }
    const deadline = effectiveDeadline(n, task);
    if (deadline !== null) {
      const finish = finishOf(state, task.id);
      if (unplaced > 0 || (finish !== null && finish > deadline)) {
        const conflict = deadlineConflict(ctx, state, task, deadline);
        conflicts.push(conflict);
        if (!hasBlocks) unscheduled.push({ taskId: task.id, reason: conflict.code });
      }
      continue;
    }
    if (unplaced > 0) {
      overloaded.push(task);
      if (!hasBlocks) unscheduled.push({ taskId: task.id, reason: "OVERLOAD" });
    }
  }
  if (overloaded.length > 0) {
    conflicts.push({
      code: "OVERLOAD",
      taskIds: overloaded.map((t) => t.id),
      details: {
        unplacedMinutes: overloaded.reduce((sum, t) => sum + remainingOf(state, t), 0),
        horizonEnd: minutesToIso(n.horizonEnd),
      },
      alternatives: ["reduce_scope", "delegate", "extend_deadline"],
    });
  }
  unscheduled.sort((a, b) => a.taskId.localeCompare(b.taskId));
  conflicts.sort(compareConflicts);
  return { unscheduled, conflicts };
}
