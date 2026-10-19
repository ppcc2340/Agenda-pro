/**
 * Mutable working state of a plan: the day windows plus every block placed so
 * far (pinned, kept from the previous plan, or newly placed). Trial placements
 * (stability checks, limited backtracking) work on a clone and are committed by
 * replacing the state, which keeps the greedy loop simple and deterministic.
 */
import { localDateKey, localParts } from "./calendar-math";
import { buildDays, subtractInterval, type DayState } from "./capacity";
import type { Normalized } from "./normalize";

export interface ScheduledBlock {
  /** Id of the existing block it came from; null for newly placed blocks. */
  readonly sourceId: string | null;
  readonly taskId: string;
  readonly start: number;
  readonly end: number;
  readonly pinned: boolean;
  /** True when it was taken unchanged from the previous plan (stability). */
  readonly kept: boolean;
  /** Index into `days`; -1 when the block lies outside every work day (pinned by the user). */
  readonly dayIndex: number;
  readonly inDeepWindow: boolean;
  /** Length of the free gap it was placed into, when that gap was a short one. */
  readonly gapMinutes: number | null;
}

export interface ScheduleState {
  readonly days: DayState[];
  blocks: ScheduledBlock[];
}

export function createState(n: Normalized): ScheduleState {
  return { days: buildDays(n), blocks: [] };
}

export function cloneState(state: ScheduleState): ScheduleState {
  return {
    days: state.days.map((d) => ({ ...d, free: [...d.free] })),
    blocks: [...state.blocks],
  };
}

/** Index of the work day containing the instant, by local date; -1 when not a work day. */
export function dayIndexAt(state: ScheduleState, n: Normalized, instant: number): number {
  const key = localDateKey(localParts(instant, n.preferences.timezone));
  const day = state.days.find((d) => d.key === key);
  return day === undefined ? -1 : day.index;
}

/** Recomputes `free` and `assigned` of a day from its base windows and current blocks. */
function recomputeDay(state: ScheduleState, n: Normalized, dayIndex: number): void {
  const day = state.days[dayIndex];
  if (day === undefined) return;
  const buffer = n.preferences.bufferMinutes;
  let free = [...day.baseFree];
  let assigned = 0;
  for (const block of state.blocks) {
    if (block.dayIndex !== dayIndex) continue;
    // Transition buffer on both sides of a Meri block ("between blocks").
    free = subtractInterval(free, block.start - buffer, block.end + buffer);
    assigned += block.end - block.start;
  }
  day.free = free;
  day.assigned = assigned;
}

export function addBlock(state: ScheduleState, n: Normalized, block: ScheduledBlock): void {
  state.blocks.push(block);
  recomputeDay(state, n, block.dayIndex);
}

export function removeBlock(state: ScheduleState, n: Normalized, block: ScheduledBlock): void {
  state.blocks = state.blocks.filter((b) => b !== block);
  recomputeDay(state, n, block.dayIndex);
}

export function blocksOf(state: ScheduleState, taskId: string): ScheduledBlock[] {
  return state.blocks.filter((b) => b.taskId === taskId);
}

export function assignedMinutes(state: ScheduleState, taskId: string): number {
  return blocksOf(state, taskId).reduce((sum, b) => sum + (b.end - b.start), 0);
}

/** End of the task's last block, or null when it has none. */
export function finishOf(state: ScheduleState, taskId: string): number | null {
  const blocks = blocksOf(state, taskId);
  if (blocks.length === 0) return null;
  return Math.max(...blocks.map((b) => b.end));
}

/** True when [start, end) lies entirely inside one free slot of the day. */
export function fitsInFree(day: DayState, start: number, end: number): boolean {
  return day.free.some((slot) => slot.start <= start && end <= slot.end);
}
