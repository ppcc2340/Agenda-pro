import { describe, expect, it } from "vitest";
import { demoInput, task } from "./fixtures";
import { findCycleMembers, normalize } from "./normalize";

describe("normalize", () => {
  it("finds only the members of cycles, not their downstream tasks", () => {
    const cycle = findCycleMembers([
      { id: "a", blockedBy: ["c"] },
      { id: "b", blockedBy: ["a"] },
      { id: "c", blockedBy: ["b"] },
      { id: "d", blockedBy: ["c"] },
      { id: "self", blockedBy: ["self"] },
      { id: "free", blockedBy: ["missing"] },
    ]);
    expect([...cycle].sort()).toEqual(["a", "b", "c", "self"]);
  });

  it("drops unknown and completed dependencies, keeps circular ones so dependents block", () => {
    const n = normalize(demoInput({
      tasks: [
        task({ id: "done", status: "completed" }),
        task({ id: "x", blockedBy: ["done", "ghost", "loop"] }),
        task({ id: "loop", blockedBy: ["loop"] }),
      ],
    }));
    expect(n.completedIds).toEqual(["done"]);
    expect(n.cycleIds).toEqual(["loop"]);
    expect(n.tasks.get("x")?.deps).toEqual(["loop"]);
    expect(n.tasks.has("loop")).toBe(false);
  });

  it("defaults remaining minutes to the estimate and ignores free events", () => {
    const n = normalize(demoInput({
      tasks: [task({ id: "a", estimateMinutes: 90 }), task({ id: "b", estimateMinutes: 90, remainingMinutes: 20 })],
      fixedEvents: [
        { id: "busy", startsAt: "2026-10-19T08:00:00.000Z", endsAt: "2026-10-19T09:00:00.000Z", busy: true },
        { id: "free", startsAt: "2026-10-19T08:00:00.000Z", endsAt: "2026-10-19T09:00:00.000Z", busy: false },
      ],
    }));
    expect(n.tasks.get("a")?.remaining).toBe(90);
    expect(n.tasks.get("b")?.remaining).toBe(20);
    expect(n.fixedEvents.map((e) => e.id)).toEqual(["busy"]);
  });

  it("rejects non-object input with a schema error", () => {
    expect(() => normalize(null)).toThrow(/Invalid plan input/);
  });
});
