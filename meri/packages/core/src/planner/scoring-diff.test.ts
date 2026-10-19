import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff";
import { demoInput, task } from "./fixtures";
import { normalize } from "./normalize";
import { createState } from "./schedule-state";
import { compareByScore, deadlineUrgency, priorityWeight, scoreTasks } from "./scoring";
import type { PlannedBlock } from "./types";
import { DEFAULT_WEIGHTS } from "./weights";

describe("scoring", () => {
  it("maps priorities and bounds deadline urgency, doubling it for hard deadlines", () => {
    expect([1, 2, 3, 4].map(priorityWeight)).toEqual([1, 0.75, 0.5, 0.25]);
    expect(deadlineUrgency(null, "soft")).toBe(0);
    expect(deadlineUrgency(2, "soft")).toBe(0.5);
    expect(deadlineUrgency(-10, "soft")).toBe(4);
    expect(deadlineUrgency(-10, "hard")).toBe(8);
  });

  it("ranks urgent, high-priority and unblocking tasks first and breaks ties deterministically", () => {
    const n = normalize(
      demoInput({
        tasks: [
          task({ id: "calm", priority: 4 }),
          task({ id: "urgent", priority: 4, dueAt: "2026-10-19T12:00:00.000Z", deadlineType: "hard" }),
          task({ id: "p1", priority: 1 }),
          task({ id: "root", priority: 4 }),
          task({ id: "leaf", priority: 4, blockedBy: ["root"] }),
          task({ id: "tie-a", priority: 2 }),
          task({ id: "tie-b", priority: 2 }),
        ],
      }),
    );
    const scores = scoreTasks(n, createState(n).days, DEFAULT_WEIGHTS);
    const order = [...n.tasks.values()].sort(compareByScore(scores)).map((t) => t.id);
    expect(order.slice(0, 2)).toEqual(["urgent", "p1"]);
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("calm"));
    expect(order.indexOf("tie-a")).toBeLessThan(order.indexOf("tie-b"));
    expect(scores.get("urgent")?.estimatedSlackHours).toBeLessThan(4);
    expect(scores.get("calm")?.estimatedSlackHours).toBeNull();
    expect(scores.get("root")?.descendants).toBe(1);
  });

  it("orders by due date, then priority, when scores tie", () => {
    const n = normalize(
      demoInput({
        tasks: [
          task({ id: "later", dueAt: "2026-10-23T12:00:00.000Z" }),
          task({ id: "sooner", dueAt: "2026-10-22T12:00:00.000Z" }),
          task({ id: "none" }),
        ],
      }),
    );
    const scores = new Map(
      [...n.tasks.keys()].map((id) => [id, { id, score: 1, estimatedSlackHours: null, descendants: 0 }]),
    );
    const order = [...n.tasks.values()].sort(compareByScore(scores)).map((t) => t.id);
    expect(order).toEqual(["sooner", "later", "none"]);
    scores.delete("none");
    expect([...n.tasks.values()].sort(compareByScore(scores)).map((t) => t.id)).toEqual([
      "sooner",
      "later",
      "none",
    ]);
    const sameDue = [...n.tasks.values()].filter((t) => t.id !== "none").map((t) => ({ ...t, dueAt: 1 }));
    expect(sameDue.sort(compareByScore(scores)).map((t) => t.id)).toEqual(["later", "sooner"]);
  });
});

describe("diff", () => {
  const block = (taskId: string, startsAt: string, endsAt: string): PlannedBlock => ({
    taskId,
    startsAt,
    endsAt,
    pinned: false,
    reasons: [],
  });
  const existing = (
    id: string,
    taskId: string,
    startsAt: string,
    endsAt: string,
  ): { id: string; taskId: string; start: number; end: number; pinned: boolean } => ({
    id,
    taskId,
    start: Date.parse(startsAt) / 60000,
    end: Date.parse(endsAt) / 60000,
    pinned: false,
  });

  it("classifies unchanged, moved, added and removed blocks per task", () => {
    const before = [
      existing("1", "a", "2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z"),
      existing("2", "a", "2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"),
      existing("3", "b", "2026-10-19T11:00:00.000Z", "2026-10-19T12:00:00.000Z"),
    ];
    const after = [
      block("a", "2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z"),
      block("a", "2026-10-19T13:00:00.000Z", "2026-10-19T14:00:00.000Z"),
      block("c", "2026-10-19T15:00:00.000Z", "2026-10-19T16:00:00.000Z"),
    ];
    expect(computeDiff(before, after)).toEqual({
      added: [after[2]],
      removed: [{ taskId: "b", startsAt: "2026-10-19T11:00:00.000Z", endsAt: "2026-10-19T12:00:00.000Z" }],
      moved: [
        {
          taskId: "a",
          from: { startsAt: "2026-10-19T09:00:00.000Z", endsAt: "2026-10-19T10:00:00.000Z" },
          to: { startsAt: "2026-10-19T13:00:00.000Z", endsAt: "2026-10-19T14:00:00.000Z" },
        },
      ],
    });
  });

  it("is empty when nothing changed", () => {
    const before = [existing("1", "a", "2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z")];
    expect(computeDiff(before, [block("a", "2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z")])).toEqual(
      { added: [], removed: [], moved: [] },
    );
  });
});
