/**
 * Step 4 of docs/04: score = w_p·priority + w_d·deadlineUrgency + w_c·costOfDelay
 *                            + w_b·unblocksOthers − w_s·slackBonus
 * Slack depends on the work of higher-scored tasks, which depends on scores, so
 * scoring runs in two passes: a preliminary score (own work only) fixes the
 * order, then slack is recomputed with the accumulated higher-scored work.
 */
import { grossCapacityBetween, type DayState } from "./capacity";
import type { Normalized, NormalizedTask } from "./normalize";
import type { Weights } from "./weights";

export interface ScoredTask {
  readonly id: string;
  readonly score: number;
  /** Work hours until the deadline minus own and higher-scored pending work; null without deadline. */
  readonly estimatedSlackHours: number | null;
  /** Transitive dependents (tasks this one unblocks). */
  readonly descendants: number;
}

/** Urgency is bounded so a deadline already missed cannot dominate everything else. */
const MAX_URGENCY = 4;
/** A week of work hours is "plenty of slack"; beyond that the bonus saturates. */
const SLACK_SATURATION_HOURS = 40;
const MAX_REWARDED_DESCENDANTS = 3;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** P1 -> 1, P2 -> 0.75, P3 -> 0.5, P4 -> 0.25 */
export function priorityWeight(priority: number): number {
  return (5 - priority) / 4;
}

export function deadlineUrgency(slackHours: number | null, deadlineType: "soft" | "hard"): number {
  if (slackHours === null) return 0;
  const urgency = Math.min(1 / Math.max(slackHours, 0.25), MAX_URGENCY);
  return deadlineType === "hard" ? urgency * 2 : urgency;
}

export function countDescendants(n: Normalized, taskId: string): number {
  const seen = new Set<string>();
  const stack = [...(n.tasks.get(taskId)?.dependents ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(n.tasks.get(id)?.dependents ?? []));
  }
  return seen.size;
}

interface ScoreParts {
  priority: number;
  costOfDelay: number;
  unblocks: number;
  hoursUntilDue: number | null;
}

function combine(parts: ScoreParts, slackHours: number | null, deadlineType: "soft" | "hard", w: Weights): number {
  const slackBonus = slackHours === null ? 1 : clamp01(slackHours / SLACK_SATURATION_HOURS);
  return (
    w.priority * parts.priority +
    w.deadlineUrgency * deadlineUrgency(slackHours, deadlineType) +
    w.costOfDelay * parts.costOfDelay +
    w.unblocksOthers * parts.unblocks -
    w.slackBonus * slackBonus
  );
}

/** Deterministic order: score desc, dueAt asc (none last), priority asc, id asc. */
export function compareByScore(scores: ReadonlyMap<string, ScoredTask>): (a: NormalizedTask, b: NormalizedTask) => number {
  return (a, b) => {
    const sa = scores.get(a.id)?.score ?? 0;
    const sb = scores.get(b.id)?.score ?? 0;
    if (sa !== sb) return sb - sa;
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt - b.dueAt;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id < b.id ? -1 : 1;
  };
}

export function scoreTasks(n: Normalized, days: readonly DayState[], w: Weights): Map<string, ScoredTask> {
  const horizonHours = Math.max((n.horizonEnd - n.now) / 60, 1);
  const parts = new Map<string, ScoreParts>();
  const capacityUntilDue = new Map<string, number>();
  for (const task of n.tasks.values()) {
    const hoursUntilDue = task.dueAt === null ? null : (task.dueAt - n.now) / 60;
    // Cost of delay grows as the deadline approaches within the horizon.
    const costOfDelay = hoursUntilDue === null ? 0 : clamp01(1 - hoursUntilDue / horizonHours);
    parts.set(task.id, {
      priority: priorityWeight(task.priority),
      costOfDelay,
      unblocks: Math.min(countDescendants(n, task.id), MAX_REWARDED_DESCENDANTS) / MAX_REWARDED_DESCENDANTS,
      hoursUntilDue,
    });
    if (task.dueAt !== null) {
      capacityUntilDue.set(task.id, grossCapacityBetween(days, n.preferences, n.now, task.dueAt) / 60);
    }
  }
  const ownSlack = (task: NormalizedTask): number | null => {
    const capacity = capacityUntilDue.get(task.id);
    return capacity === undefined ? null : capacity - task.remaining / 60;
  };
  const preliminary = new Map<string, ScoredTask>();
  for (const task of n.tasks.values()) {
    const p = parts.get(task.id);
    if (p === undefined) continue;
    preliminary.set(task.id, {
      id: task.id,
      score: combine(p, ownSlack(task), task.deadlineType, w),
      estimatedSlackHours: ownSlack(task),
      descendants: countDescendants(n, task.id),
    });
  }
  const ordered = [...n.tasks.values()].sort(compareByScore(preliminary));
  const final = new Map<string, ScoredTask>();
  let accumulatedHours = 0;
  for (const task of ordered) {
    const p = parts.get(task.id);
    const prelim = preliminary.get(task.id);
    if (p === undefined || prelim === undefined) continue;
    const capacity = capacityUntilDue.get(task.id);
    const slack = capacity === undefined ? null : capacity - accumulatedHours - task.remaining / 60;
    final.set(task.id, { ...prelim, score: combine(p, slack, task.deadlineType, w), estimatedSlackHours: slack });
    accumulatedHours += task.remaining / 60;
  }
  return final;
}
