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

interface Entry {
  task: NormalizedTask;
  parts: ScoreParts;
  /** Work hours available between now and the deadline; null without deadline. */
  capacityHoursUntilDue: number | null;
  descendants: number;
}

function entryFor(n: Normalized, days: readonly DayState[], task: NormalizedTask): Entry {
  const horizonHours = Math.max((n.horizonEnd - n.now) / 60, 1);
  const hoursUntilDue = task.dueAt === null ? null : (task.dueAt - n.now) / 60;
  const descendants = countDescendants(n, task.id);
  return {
    task,
    parts: {
      priority: priorityWeight(task.priority),
      // Cost of delay grows as the deadline approaches within the horizon.
      costOfDelay: hoursUntilDue === null ? 0 : clamp01(1 - hoursUntilDue / horizonHours),
      unblocks: Math.min(descendants, MAX_REWARDED_DESCENDANTS) / MAX_REWARDED_DESCENDANTS,
    },
    capacityHoursUntilDue: task.dueAt === null ? null : grossCapacityBetween(days, n.preferences, n.now, task.dueAt) / 60,
    descendants,
  };
}

function scored(e: Entry, higherScoredHours: number, w: Weights): ScoredTask {
  const slack = e.capacityHoursUntilDue === null ? null : e.capacityHoursUntilDue - higherScoredHours - e.task.remaining / 60;
  return { id: e.task.id, score: combine(e.parts, slack, e.task.deadlineType, w), estimatedSlackHours: slack, descendants: e.descendants };
}

export function scoreTasks(n: Normalized, days: readonly DayState[], w: Weights): Map<string, ScoredTask> {
  const entries = [...n.tasks.values()].map((task) => entryFor(n, days, task));
  const preliminary = new Map(entries.map((e) => [e.task.id, scored(e, 0, w)]));
  const compare = compareByScore(preliminary);
  entries.sort((a, b) => compare(a.task, b.task));
  const final = new Map<string, ScoredTask>();
  let accumulatedHours = 0;
  for (const e of entries) {
    final.set(e.task.id, scored(e, accumulatedHours, w));
    accumulatedHours += e.task.remaining / 60;
  }
  return final;
}
