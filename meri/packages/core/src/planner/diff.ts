/**
 * docs/04 "diff": compares the new plan against the blocks the user already had.
 * Blocks are matched per task: identical intervals are unchanged, the remaining
 * ones pair up in chronological order as "moved", and the surplus on either side
 * is "added" or "removed".
 */
import { minutesToIso } from "./calendar-math";
import type { NormalizedExistingBlock } from "./normalize";
import type { PlanDiff, PlannedBlock } from "./types";

interface Interval {
  startsAt: string;
  endsAt: string;
}

function sameInterval(a: Interval, b: Interval): boolean {
  return a.startsAt === b.startsAt && a.endsAt === b.endsAt;
}

export function computeDiff(
  existing: readonly NormalizedExistingBlock[],
  blocks: readonly PlannedBlock[],
): PlanDiff {
  const diff: PlanDiff = { added: [], removed: [], moved: [] };
  const taskIds = [...new Set([...existing.map((b) => b.taskId), ...blocks.map((b) => b.taskId)])].sort();
  for (const taskId of taskIds) {
    const before: Interval[] = existing
      .filter((b) => b.taskId === taskId)
      .map((b) => ({ startsAt: minutesToIso(b.start), endsAt: minutesToIso(b.end) }));
    const after = blocks.filter((b) => b.taskId === taskId);
    const unchanged = new Set<PlannedBlock>();
    const stillBefore: Interval[] = [];
    for (const old of before) {
      const match = after.find((b) => !unchanged.has(b) && sameInterval(b, old));
      if (match === undefined) stillBefore.push(old);
      else unchanged.add(match);
    }
    const stillAfter = after.filter((b) => !unchanged.has(b));
    stillBefore.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const pairs = Math.min(stillBefore.length, stillAfter.length);
    for (let i = 0; i < pairs; i += 1) {
      const from = stillBefore[i];
      const to = stillAfter[i];
      if (from === undefined || to === undefined) break;
      diff.moved.push({ taskId, from, to: { startsAt: to.startsAt, endsAt: to.endsAt } });
    }
    for (const old of stillBefore.slice(pairs)) diff.removed.push({ taskId, ...old });
    diff.added.push(...stillAfter.slice(pairs));
  }
  return diff;
}
