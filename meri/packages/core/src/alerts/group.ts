/**
 * Alert grouping and daily cap (docs/01 F-13 AC2: at most `maxPerDay` alerts a day, grouped).
 * Pure: the caller supplies what happened in this run and how many alerts were already sent today.
 */
export type AlertTemplate =
  "risk.grouped" | "conflict.grouped" | "plan.proposed" | "plan.applied" | "commitment.overdue";

export interface AlertCandidate {
  kind: "risk" | "plan" | "proposals" | "integration";
  template: AlertTemplate;
  params: Record<string, string | number>;
  refs: { type: string; id: string }[];
}

export interface AlertRunInput {
  /** Tasks that became at risk in this run (ids). */
  newlyAtRisk: string[];
  /** Conflicts detected in this run (task ids per conflict), only reported once per plan version. */
  newConflicts: { code: string; taskIds: string[] }[];
  /** A reschedule proposal was created in this run. */
  proposal: { id: string; added: number; removed: number; moved: number } | null;
  /** A safe diff was applied automatically in this run. */
  applied: { added: number; removed: number } | null;
}

/**
 * Builds at most the alerts that still fit under the daily cap, most important first.
 * Each group becomes one alert (never one per task), so a noisy replan yields ≤ 4 alerts.
 */
export function buildAlerts(
  input: AlertRunInput,
  cap: { maxPerDay: number; sentToday: number },
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];
  if (input.newlyAtRisk.length > 0) {
    candidates.push({
      kind: "risk",
      template: "risk.grouped",
      params: { count: input.newlyAtRisk.length },
      refs: input.newlyAtRisk.map((id) => ({ type: "task", id })),
    });
  }
  if (input.newConflicts.length > 0) {
    const ids = [...new Set(input.newConflicts.flatMap((c) => c.taskIds))];
    candidates.push({
      kind: "risk",
      template: "conflict.grouped",
      params: { count: input.newConflicts.length, tasks: ids.length },
      refs: ids.map((id) => ({ type: "task", id })),
    });
  }
  if (input.proposal) {
    candidates.push({
      kind: "plan",
      template: "plan.proposed",
      params: { added: input.proposal.added, removed: input.proposal.removed, moved: input.proposal.moved },
      refs: [{ type: "proposal", id: input.proposal.id }],
    });
  }
  if (input.applied && input.applied.added + input.applied.removed > 0) {
    candidates.push({
      kind: "plan",
      template: "plan.applied",
      params: { added: input.applied.added, removed: input.applied.removed },
      refs: [],
    });
  }
  const room = Math.max(0, cap.maxPerDay - cap.sentToday);
  return candidates.slice(0, room);
}
