/**
 * Step 5 of docs/04: greedy placement of one task into the free space.
 * Deep tasks prefer deep-work windows (across all days, that is why the user
 * configured them) with blocks >= minDeepBlockMinutes; shallow tasks prefer the
 * short gaps of each day so long windows stay available for deep work. Long
 * tasks are split into blocks >= minBlockMinutes, never before `earliest`
 * (dependencies + buffer) and never ending after `deadline` when one is given.
 */
import { intersectSlots, type DayState, type Slot } from "./capacity";
import type { Normalized, NormalizedTask } from "./normalize";
import { addBlock, type ScheduledBlock, type ScheduleState } from "./schedule-state";

export interface PlacementRequest {
  readonly task: NormalizedTask;
  readonly remaining: number;
  readonly earliest: number;
  /** Blocks must end at or before this instant; null = only the horizon limits them. */
  readonly deadline: number | null;
}

export interface PlacementResult {
  readonly placed: ScheduledBlock[];
  readonly unplaced: number;
}

interface Candidate {
  readonly day: DayState;
  readonly slot: Slot;
  readonly inDeepWindow: boolean;
  readonly gapMinutes: number | null;
}

function isShortGap(slot: Slot, n: Normalized): boolean {
  return slot.end - slot.start < n.preferences.minDeepBlockMinutes;
}

/** Candidate slots in preference order for the task kind; recomputed after every placement. */
function candidates(state: ScheduleState, n: Normalized, task: NormalizedTask): Candidate[] {
  const list: Candidate[] = [];
  if (task.kind === "deep") {
    for (const day of state.days) {
      for (const slot of intersectSlots(day.free, day.deepWindows)) {
        list.push({ day, slot, inDeepWindow: true, gapMinutes: null });
      }
    }
    for (const day of state.days) {
      for (const slot of day.free) list.push({ day, slot, inDeepWindow: false, gapMinutes: null });
    }
    return list;
  }
  for (const day of state.days) {
    const gaps = day.free.filter((s) => isShortGap(s, n));
    const wide = day.free.filter((s) => !isShortGap(s, n));
    for (const slot of gaps) list.push({ day, slot, inDeepWindow: false, gapMinutes: slot.end - slot.start });
    for (const slot of wide) list.push({ day, slot, inDeepWindow: false, gapMinutes: null });
  }
  return list;
}

function minimumBlock(task: NormalizedTask, n: Normalized): number {
  return task.kind === "deep" ? n.preferences.minDeepBlockMinutes : n.preferences.minBlockMinutes;
}

/**
 * Minutes to place in this candidate, or 0 when it is not usable. A task
 * shorter than the minimum block is still placeable as a single block; a split
 * never leaves a tail shorter than the minimum when it can be avoided.
 */
function chunkFor(c: Candidate, req: PlacementRequest, n: Normalized): { start: number; minutes: number } {
  const start = Math.max(c.slot.start, req.earliest);
  const end = req.deadline === null ? c.slot.end : Math.min(c.slot.end, req.deadline);
  const capacityLeft = c.day.capacity - c.day.assigned;
  const usable = Math.min(end - start, capacityLeft);
  const minimum = minimumBlock(req.task, n);
  const minUnit = Math.min(minimum, req.remaining);
  if (usable < minUnit) return { start, minutes: 0 };
  let minutes = Math.min(req.remaining, usable);
  const tail = req.remaining - minutes;
  if (tail > 0 && tail < minimum) {
    const shrink = minimum - tail;
    if (minutes - shrink >= minimum) minutes -= shrink;
  }
  return { start, minutes };
}

/** Places as much of the request as possible; mutates `state`. */
export function placeTask(state: ScheduleState, n: Normalized, req: PlacementRequest): PlacementResult {
  const placed: ScheduledBlock[] = [];
  let remaining = req.remaining;
  while (remaining > 0) {
    let chosen: { candidate: Candidate; start: number; minutes: number } | null = null;
    for (const candidate of candidates(state, n, req.task)) {
      const chunk = chunkFor(candidate, { ...req, remaining }, n);
      if (chunk.minutes > 0) {
        chosen = { candidate, ...chunk };
        break;
      }
    }
    if (chosen === null) break;
    const block: ScheduledBlock = {
      sourceId: null,
      taskId: req.task.id,
      start: chosen.start,
      end: chosen.start + chosen.minutes,
      pinned: false,
      kept: false,
      dayIndex: chosen.candidate.day.index,
      inDeepWindow: chosen.candidate.inDeepWindow,
      gapMinutes: chosen.candidate.gapMinutes,
    };
    addBlock(state, n, block);
    placed.push(block);
    remaining -= chosen.minutes;
  }
  return { placed, unplaced: remaining };
}
