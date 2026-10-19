/**
 * Golden scenarios: the demo week and the documented edge cases of docs/04.
 * Madrid in October is UTC+2, so 09:00 local = 07:00Z.
 */
import { describe, expect, it } from "vitest";
import { demoInput, event, isoPlusMinutes, task } from "./fixtures";
import { PlannerInputError } from "./normalize";
import { plan } from "./plan";
import type { ExistingBlock, PlannedBlock } from "./types";

const codes = (b: PlannedBlock): string[] => b.reasons.map((r) => r.code);
const asExisting = (blocks: readonly PlannedBlock[], pinned: boolean): ExistingBlock[] =>
  blocks.map((b, i) => ({ id: `b${String(i)}`, taskId: b.taskId, startsAt: b.startsAt, endsAt: b.endsAt, pinned }));

describe("plan: demo week", () => {
  const brief = task({ id: "brief", kind: "deep", priority: 1, estimateMinutes: 180, dueAt: "2026-10-22T16:00:00.000Z", deadlineType: "hard" });
  const emails = task({ id: "emails", kind: "shallow", priority: 3, estimateMinutes: 30 });
  const meeting = event("client", "2026-10-19T11:30:00.000Z", "2026-10-19T12:30:00.000Z");

  it("places the deep task due Thursday in Monday's deep-work window", () => {
    const out = plan(demoInput({ tasks: [brief, emails], fixedEvents: [meeting] }));
    const block = out.blocks.find((b) => b.taskId === "brief");
    expect(block).toMatchObject({ startsAt: "2026-10-19T07:00:00.000Z", endsAt: "2026-10-19T10:00:00.000Z", pinned: false });
    expect(codes(block ?? out.blocks[0] ?? { reasons: [] } as unknown as PlannedBlock)).toEqual(
      expect.arrayContaining(["DEEP_WORK_WINDOW", "DEADLINE_HARD", "HIGH_PRIORITY"]),
    );
    expect(out.conflicts).toEqual([]);
    expect(out.unscheduled).toEqual([]);
  });

  it("fills the short gap before the meeting with the shallow task", () => {
    const out = plan(demoInput({ tasks: [brief, emails], fixedEvents: [meeting] }));
    const block = out.blocks.find((b) => b.taskId === "emails");
    // brief ends 10:00Z, +15 buffer → 10:15Z; the meeting starts 11:30Z → a 75-minute gap.
    expect(block).toMatchObject({ startsAt: "2026-10-19T10:15:00.000Z", endsAt: "2026-10-19T10:45:00.000Z" });
    expect(block?.reasons).toContainEqual({ code: "FILLS_GAP", params: { gapMinutes: 75 } });
  });

  it("honours the transition buffer after fixed events", () => {
    const out = plan(demoInput({ tasks: [task({ id: "a", estimateMinutes: 60 })], fixedEvents: [event("standup", "2026-10-19T07:00:00.000Z", "2026-10-19T07:30:00.000Z")] }));
    expect(out.blocks[0]?.startsAt).toBe("2026-10-19T07:45:00.000Z");
  });

  it("never assigns the contingency reserve", () => {
    const prefs = { ...demoInput().preferences, contingencyPct: 50, deepWorkWindows: [] };
    const out = plan(demoInput({ tasks: [task({ id: "long", estimateMinutes: 480 })], preferences: prefs, horizonEnd: "2026-10-19T22:00:00.000Z" }));
    // 540 work minutes × 50 % = 270 assignable.
    const total = out.blocks.reduce((s, b) => s + (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60000, 0);
    expect(total).toBe(270);
    expect(out.conflicts).toEqual([expect.objectContaining({ code: "OVERLOAD", taskIds: ["long"] })]);
  });
});

describe("plan: feasibility and conflicts", () => {
  it("reports an infeasible hard deadline with alternatives and places what fits before it", () => {
    const urgent = task({ id: "urgent", priority: 1, estimateMinutes: 600, dueAt: "2026-10-19T12:00:00.000Z", deadlineType: "hard" });
    const out = plan(demoInput({ tasks: [urgent] }));
    expect(out.conflicts).toEqual([
      expect.objectContaining({
        code: "DEADLINE_INFEASIBLE",
        taskIds: ["urgent"],
        alternatives: ["split_task", "extend_deadline", "delegate", "reduce_scope"],
      }),
    ]);
    expect(out.blocks.every((b) => b.endsAt <= "2026-10-19T12:00:00.000Z")).toBe(true);
    expect(out.conflicts[0]?.details).toMatchObject({ placedMinutes: 300, unplacedMinutes: 300, deadlineType: "hard" });
    expect(out.risks).toEqual([{ taskId: "urgent", slackHours: expect.any(Number) as number, cause: "NO_CAPACITY" }]);
    expect(out.unscheduled).toEqual([]);
  });

  it("places a soft-deadline task late rather than dropping it", () => {
    const late = task({ id: "late", estimateMinutes: 120, dueAt: "2026-10-19T06:00:00.000Z" });
    const out = plan(demoInput({ tasks: [late] }));
    expect(out.blocks).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ code: "NO_CAPACITY", details: { lateMinutes: 180 } });
  });

  it("marks a hard deadline already in the past as NO_CAPACITY and unscheduled", () => {
    const past = task({ id: "past", estimateMinutes: 60, dueAt: "2026-10-19T06:00:00.000Z", deadlineType: "hard" });
    const out = plan(demoInput({ tasks: [past] }));
    expect(out.blocks).toEqual([]);
    expect(out.unscheduled).toEqual([{ taskId: "past", reason: "NO_CAPACITY" }]);
    expect(out.conflicts[0]?.alternatives).toEqual(["extend_deadline", "delegate", "reduce_scope"]);
  });

  it("detects circular dependencies and blocks downstream tasks", () => {
    const out = plan(demoInput({
      tasks: [
        task({ id: "a", blockedBy: ["b"] }),
        task({ id: "b", blockedBy: ["a"] }),
        task({ id: "c", blockedBy: ["a"], dueAt: "2026-10-21T16:00:00.000Z" }),
        task({ id: "free" }),
      ],
    }));
    expect(out.conflicts).toEqual([{ code: "CIRCULAR_DEPENDENCY", taskIds: ["a", "b"], details: { count: 2 }, alternatives: [] }]);
    expect(out.unscheduled).toEqual([
      { taskId: "a", reason: "CIRCULAR_DEPENDENCY" },
      { taskId: "b", reason: "CIRCULAR_DEPENDENCY" },
      { taskId: "c", reason: "BLOCKED" },
    ]);
    expect(out.risks).toEqual([{ taskId: "c", slackHours: expect.any(Number) as number, cause: "BLOCKED_DEPENDENCY" }]);
    expect(out.blocks.map((b) => b.taskId)).toEqual(["free"]);
  });

  it("flags a dependency that finishes after the dependent's deadline", () => {
    const out = plan(demoInput({
      tasks: [
        task({ id: "first", kind: "deep", estimateMinutes: 420 }),
        task({ id: "second", blockedBy: ["first"], estimateMinutes: 30, dueAt: "2026-10-19T12:00:00.000Z", deadlineType: "hard" }),
      ],
    }));
    expect(out.conflicts).toEqual([expect.objectContaining({ code: "DEPENDENCY_AFTER_DEADLINE", taskIds: ["second", "first"] })]);
    expect(out.unscheduled).toEqual([{ taskId: "second", reason: "DEPENDENCY_AFTER_DEADLINE" }]);
    const soft = plan(demoInput({
      tasks: [
        task({ id: "first", kind: "deep", estimateMinutes: 420 }),
        task({ id: "second", blockedBy: ["first"], estimateMinutes: 30, dueAt: "2026-10-19T12:00:00.000Z" }),
      ],
    }));
    expect(soft.unscheduled).toEqual([]);
    expect(soft.blocks.find((b) => b.taskId === "second")?.reasons).toContainEqual({ code: "DEPENDENCY_ORDER", params: { after: "first" } });
  });

  it("lists completed tasks as COMPLETED and tasks that do not fit as OVERLOAD", () => {
    const out = plan(demoInput({
      horizonEnd: "2026-10-19T22:00:00.000Z",
      tasks: [task({ id: "done", status: "completed" }), task({ id: "big", estimateMinutes: 480 }), task({ id: "huge", priority: 4, estimateMinutes: 480 })],
    }));
    expect(out.unscheduled).toEqual([{ taskId: "done", reason: "COMPLETED" }, { taskId: "huge", reason: "OVERLOAD" }]);
    expect(out.conflicts).toEqual([expect.objectContaining({ code: "OVERLOAD", taskIds: ["big", "huge"] })]);
  });

  it("flags low slack as a risk and as a block reason", () => {
    const tight = task({ id: "tight", kind: "deep", estimateMinutes: 180, dueAt: "2026-10-19T11:00:00.000Z" });
    const out = plan(demoInput({ tasks: [tight] }));
    expect(out.risks).toEqual([{ taskId: "tight", slackHours: 0.8, cause: "LOW_SLACK" }]);
    expect(out.blocks[0]?.reasons).toContainEqual({ code: "DEADLINE_SLACK_LOW", params: { dueAt: "2026-10-19T11:00:00.000Z", slackHours: 0.8 } });
  });
});

describe("plan: stability", () => {
  const tasks = [
    task({ id: "deep", kind: "deep", priority: 2, estimateMinutes: 120 }),
    task({ id: "admin", priority: 4, estimateMinutes: 45 }),
  ];

  it("keeps a pinned block as-is (even on a weekend) and only plans the rest", () => {
    const pinned: ExistingBlock = { id: "p1", taskId: "deep", startsAt: "2026-10-24T08:00:00.000Z", endsAt: "2026-10-24T09:00:00.000Z", pinned: true };
    const out = plan(demoInput({ tasks, existingBlocks: [pinned] }));
    const deep = out.blocks.filter((b) => b.taskId === "deep");
    expect(deep).toContainEqual(expect.objectContaining({ startsAt: pinned.startsAt, endsAt: pinned.endsAt, pinned: true }));
    expect(deep.find((b) => b.pinned)?.reasons).toEqual([{ code: "PINNED_BY_USER", params: { blockId: "p1" } }, { code: "HIGH_PRIORITY", params: { priority: 2 } }]);
    expect(deep.reduce((s, b) => s + (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60000, 0)).toBe(120);
  });

  it("is idempotent when re-planning with the output pinned", () => {
    const first = plan(demoInput({ tasks }));
    const second = plan(demoInput({ tasks, existingBlocks: asExisting(first.blocks, true) }));
    expect(second.blocks.map((b) => [b.taskId, b.startsAt, b.endsAt])).toEqual(first.blocks.map((b) => [b.taskId, b.startsAt, b.endsAt]));
    expect(second.diff).toEqual({ added: [], removed: [], moved: [] });
  });

  it("keeps valid non-pinned blocks (KEPT_STABLE) with an empty diff", () => {
    const first = plan(demoInput({ tasks }));
    const second = plan(demoInput({ tasks, existingBlocks: asExisting(first.blocks, false) }));
    expect(second.blocks.every((b) => codes(b).includes("KEPT_STABLE"))).toBe(true);
    expect(second.diff).toEqual({ added: [], removed: [], moved: [] });
  });

  it("moves a block that is no longer valid and reports it in the diff", () => {
    const first = plan(demoInput({ tasks }));
    const adminBlock = first.blocks.find((b) => b.taskId === "admin");
    const clash = event("new-meeting", adminBlock?.startsAt ?? "", isoPlusMinutes(adminBlock?.endsAt ?? "", 30));
    const second = plan(demoInput({ tasks, fixedEvents: [clash], existingBlocks: asExisting(first.blocks, false) }));
    expect(second.diff.moved).toHaveLength(1);
    expect(second.diff.moved[0]).toMatchObject({ taskId: "admin", from: { startsAt: adminBlock?.startsAt } });
  });

  it("re-places a kept block when the gain beats the movement penalty", () => {
    const friday: ExistingBlock = { id: "f", taskId: "admin", startsAt: "2026-10-23T14:00:00.000Z", endsAt: "2026-10-23T14:45:00.000Z", pinned: false };
    const out = plan(demoInput({ tasks: [tasks[1] ?? task({ id: "admin" })], existingBlocks: [friday] }));
    expect(out.blocks[0]?.startsAt).toBe("2026-10-19T07:00:00.000Z");
    expect(out.diff.moved).toHaveLength(1);
  });

  it("drops existing blocks of unknown or completed tasks", () => {
    const stale: ExistingBlock = { id: "s", taskId: "ghost", startsAt: "2026-10-19T07:00:00.000Z", endsAt: "2026-10-19T08:00:00.000Z", pinned: true };
    const out = plan(demoInput({ tasks: [], existingBlocks: [stale] }));
    expect(out.blocks).toEqual([]);
    expect(out.diff.removed).toEqual([{ taskId: "ghost", startsAt: stale.startsAt, endsAt: stale.endsAt }]);
  });

  it("displaces a lower-scored existing block for a hard deadline (limited backtracking)", () => {
    const filler = task({ id: "filler", priority: 4, estimateMinutes: 420 });
    const first = plan(demoInput({ tasks: [filler], horizonEnd: "2026-10-19T22:00:00.000Z", preferences: { ...demoInput().preferences, deepWorkWindows: [] } }));
    expect(first.blocks).toHaveLength(1);
    const rush = task({ id: "rush", priority: 1, estimateMinutes: 60, dueAt: "2026-10-19T16:00:00.000Z", deadlineType: "hard" });
    const second = plan(demoInput({
      tasks: [filler, rush],
      horizonEnd: "2026-10-19T22:00:00.000Z",
      preferences: { ...demoInput().preferences, deepWorkWindows: [] },
      existingBlocks: asExisting(first.blocks, false),
    }));
    expect(second.unscheduled).toEqual([]);
    expect(second.conflicts.map((c) => c.code)).not.toContain("DEADLINE_INFEASIBLE");
    expect(second.blocks.find((b) => b.taskId === "rush")?.endsAt ?? "").toBeLessThanOrEqual("2026-10-19T16:00:00.000Z");
    expect(second.diff.moved.length + second.diff.removed.length).toBeGreaterThan(0);
  });
});

describe("plan: validation", () => {
  it("throws PlannerInputError on schema violations", () => {
    expect(() => plan(demoInput({ tasks: [task({ id: "x", priority: 9 })] }))).toThrow(PlannerInputError);
  });

  it("throws on semantic violations (zone, hours, horizon, windows, blocks)", () => {
    const bad = demoInput({ preferences: { ...demoInput().preferences, timezone: "Mars/Olympus" } });
    expect(() => plan(bad)).toThrow(/timezone/);
    expect(() => plan(demoInput({ preferences: { ...demoInput().preferences, workStart: "18:00", workEnd: "09:00" } }))).toThrow(/workStart must be before/);
    expect(() => plan(demoInput({ preferences: { ...demoInput().preferences, workStart: "25:00" } }))).toThrow(/workStart: expected HH:MM/);
    expect(() => plan(demoInput({ horizonStart: "2026-10-26T00:00:00.000Z" }))).toThrow(/horizonStart/);
    expect(() => plan(demoInput({ preferences: { ...demoInput().preferences, deepWorkWindows: [{ start: "9am", end: "noon" }] } }))).toThrow(/deepWorkWindows/);
    const block: ExistingBlock = { id: "b", taskId: "t", startsAt: "2026-10-19T09:00:00.000Z", endsAt: "2026-10-19T08:00:00.000Z", pinned: false };
    expect(() => plan(demoInput({ existingBlocks: [block] }))).toThrow(/existingBlocks/);
    expect(() => plan(demoInput({ fixedEvents: [event("e", "2026-10-19T09:00:00.000Z", "2026-10-19T08:00:00.000Z")] }))).toThrow(/fixedEvents/);
    expect(() => plan(demoInput({ tasks: [task({ id: "dup" }), task({ id: "dup" })] }))).toThrow(/duplicate/);
  });

  it("exposes the issues on the error", () => {
    try {
      plan(demoInput({ preferences: { ...demoInput().preferences, workEnd: "x" } }));
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerInputError);
      expect((error as PlannerInputError).issues.length).toBeGreaterThan(0);
      expect((error as PlannerInputError).code).toBe("INVALID_PLAN_INPUT");
      return;
    }
    throw new Error("expected PlannerInputError");
  });
});
