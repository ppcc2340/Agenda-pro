/**
 * The 8 properties of docs/04-planner-engine.md, checked with fast-check.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MINUTE_MS,
  localDateKey,
  localParts,
  localToUtcMinutes,
  parseWallTime,
  weekdayOf,
} from "./calendar-math";
import { computeDailyCapacity } from "./capacity";
import { extraTask, extraTaskSeedArb, planInputArb } from "./fixtures";
import { plan } from "./plan";
import { MAX_RELEASED_BLOCKS } from "./stability";
import type { ExistingBlock, PlanInput, PlannedBlock, PlanResult } from "./types";

const RUNS = { numRuns: 1000 };
const toMin = (iso: string): number => Date.parse(iso) / MINUTE_MS;
const minutesOf = (b: PlannedBlock): number => toMin(b.endsAt) - toMin(b.startsAt);
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

function wall(text: string): { hour: number; minute: number } {
  const parsed = parseWallTime(text);
  if (parsed === null) throw new Error(`bad wall time ${text}`);
  return parsed;
}

function assertNoOverlaps(input: PlanInput, out: PlanResult): void {
  const own = out.blocks.filter((b) => !b.pinned);
  for (const a of own) {
    for (const b of out.blocks) {
      if (a === b) continue;
      expect(overlaps(toMin(a.startsAt), toMin(a.endsAt), toMin(b.startsAt), toMin(b.endsAt))).toBe(false);
    }
    for (const e of input.fixedEvents.filter((x) => x.busy)) {
      expect(overlaps(toMin(a.startsAt), toMin(a.endsAt), toMin(e.startsAt), toMin(e.endsAt))).toBe(false);
    }
  }
}

function assertWorkHours(input: PlanInput, out: PlanResult): void {
  const p = input.preferences;
  for (const b of out.blocks.filter((x) => !x.pinned)) {
    const start = toMin(b.startsAt);
    const end = toMin(b.endsAt);
    expect(start).toBeGreaterThanOrEqual(toMin(input.now));
    expect(end).toBeLessThanOrEqual(toMin(input.horizonEnd));
    const date = localParts(start, p.timezone);
    expect(p.workDays).toContain(weekdayOf(date));
    expect(start).toBeGreaterThanOrEqual(localToUtcMinutes(date, wall(p.workStart), p.timezone));
    expect(end).toBeLessThanOrEqual(localToUtcMinutes(date, wall(p.workEnd), p.timezone));
  }
}

function assertCapacity(input: PlanInput, out: PlanResult): void {
  const capacity = new Map(computeDailyCapacity(input).map((d) => [d.date, d.capacityMinutes]));
  const used = new Map<string, number>();
  for (const b of out.blocks.filter((x) => !x.pinned)) {
    const key = localDateKey(localParts(toMin(b.startsAt), input.preferences.timezone));
    used.set(key, (used.get(key) ?? 0) + minutesOf(b));
  }
  for (const [key, minutes] of used) expect(minutes).toBeLessThanOrEqual(capacity.get(key) ?? 0);
}

function assertDependencies(input: PlanInput, out: PlanResult): void {
  const byTask = (id: string): PlannedBlock[] => out.blocks.filter((b) => b.taskId === id);
  const open = new Map(input.tasks.filter((t) => t.status !== "completed").map((t) => [t.id, t]));
  for (const task of open.values()) {
    const blocks = byTask(task.id);
    if (blocks.length === 0) continue;
    for (const depId of task.blockedBy) {
      const dep = open.get(depId);
      if (dep === undefined || depId === task.id) continue;
      const depBlocks = byTask(depId);
      const depRemaining = dep.remainingMinutes ?? dep.estimateMinutes;
      expect(depBlocks.reduce((s, b) => s + minutesOf(b), 0)).toBe(depRemaining);
      const depFinish = Math.max(0, ...depBlocks.map((b) => toMin(b.endsAt)));
      for (const b of blocks.filter((x) => !x.pinned)) {
        expect(toMin(b.startsAt)).toBeGreaterThanOrEqual(depFinish + input.preferences.bufferMinutes);
      }
    }
  }
}

function assertMinutesBound(input: PlanInput, out: PlanResult): void {
  for (const task of input.tasks) {
    const total = out.blocks.filter((b) => b.taskId === task.id).reduce((s, b) => s + minutesOf(b), 0);
    expect(total).toBeLessThanOrEqual(task.remainingMinutes ?? task.estimateMinutes);
  }
}

function asExisting(blocks: readonly PlannedBlock[], pinned: boolean): ExistingBlock[] {
  return blocks.map((b, i) => ({
    id: `b${String(i)}`,
    taskId: b.taskId,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    pinned,
  }));
}

const key = (b: { taskId: string; startsAt: string; endsAt: string }): string =>
  `${b.taskId}|${b.startsAt}|${b.endsAt}`;

describe("planner properties (docs/04)", () => {
  it("1. no overlaps between blocks nor with busy fixed events", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        assertNoOverlaps(input, plan(input));
      }),
      RUNS,
    );
  });

  it("2. no block outside work hours, work days, `now` or the horizon", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        assertWorkHours(input, plan(input));
      }),
      RUNS,
    );
  });

  it("3. daily capacity with contingency is never exceeded", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        assertCapacity(input, plan(input));
      }),
      RUNS,
    );
  });

  it("4. dependencies are respected (fully placed, then +buffer)", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        assertDependencies(input, plan(input));
      }),
      RUNS,
    );
  });

  it("5. determinism: same input, same result", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        expect(plan(input)).toEqual(plan(input));
      }),
      RUNS,
    );
  });

  it("6. idempotency: re-planning with the output pinned changes nothing", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const first = plan(input);
        const second = plan({ ...input, existingBlocks: asExisting(first.blocks, true) });
        expect(second.blocks.map(key)).toEqual(first.blocks.map(key));
        expect(second.unscheduled).toEqual(first.unscheduled);
        expect(second.diff).toEqual({ added: [], removed: [], moved: [] });
      }),
      RUNS,
    );
  });

  it("7. stability: adding one shallow task moves a bounded number of existing blocks", () => {
    fc.assert(
      fc.property(planInputArb, extraTaskSeedArb, (input, seed) => {
        const first = plan(input);
        const next: PlanInput = {
          ...input,
          tasks: [...input.tasks, extraTask(seed, input.now)],
          existingBlocks: asExisting(first.blocks, false),
        };
        const second = plan(next);
        const kept = new Set(second.blocks.map(key));
        const moved = first.blocks.filter((b) => !kept.has(key(b))).length;
        const added = second.blocks.filter((b) => b.taskId === "extra").length;
        expect(moved).toBeLessThanOrEqual(MAX_RELEASED_BLOCKS);
        expect(moved).toBeLessThanOrEqual(added + 2);
        // The re-plan must still honour every hard constraint.
        assertNoOverlaps(next, second);
        assertWorkHours(next, second);
        assertCapacity(next, second);
        assertDependencies(next, second);
        assertMinutesBound(next, second);
      }),
      RUNS,
    );
  });

  it("8. minutes assigned per task never exceed the remaining estimate", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        assertMinutesBound(input, plan(input));
      }),
      RUNS,
    );
  });
});
