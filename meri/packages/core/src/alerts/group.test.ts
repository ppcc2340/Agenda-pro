import { describe, expect, it } from "vitest";
import { buildAlerts } from "./group";

describe("buildAlerts (F-13 AC2)", () => {
  it("groups tasks at risk into a single alert with refs", () => {
    const alerts = buildAlerts(
      { newlyAtRisk: ["a", "b", "c"], newConflicts: [], proposal: null, applied: null },
      { maxPerDay: 5, sentToday: 0 },
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ template: "risk.grouped", params: { count: 3 } });
    expect(alerts[0]?.refs.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("orders risk before plan changes and respects the daily cap", () => {
    const input = {
      newlyAtRisk: ["a"],
      newConflicts: [{ code: "OVERLOAD", taskIds: ["a", "b"] }],
      proposal: { id: "p1", added: 1, removed: 0, moved: 2 },
      applied: { added: 2, removed: 0 },
    };
    expect(buildAlerts(input, { maxPerDay: 5, sentToday: 0 }).map((a) => a.template)).toEqual([
      "risk.grouped",
      "conflict.grouped",
      "plan.proposed",
      "plan.applied",
    ]);
    expect(buildAlerts(input, { maxPerDay: 5, sentToday: 3 }).map((a) => a.template)).toEqual([
      "risk.grouped",
      "conflict.grouped",
    ]);
    expect(buildAlerts(input, { maxPerDay: 5, sentToday: 5 })).toEqual([]);
    expect(buildAlerts(input, { maxPerDay: 0, sentToday: 0 })).toEqual([]);
  });

  it("emits nothing for an empty or no-op run", () => {
    expect(
      buildAlerts(
        { newlyAtRisk: [], newConflicts: [], proposal: null, applied: { added: 0, removed: 0 } },
        { maxPerDay: 5, sentToday: 0 },
      ),
    ).toEqual([]);
  });

  it("deduplicates task refs across conflicts", () => {
    const [alert] = buildAlerts(
      {
        newlyAtRisk: [],
        newConflicts: [
          { code: "OVERLOAD", taskIds: ["a", "b"] },
          { code: "DEADLINE_INFEASIBLE", taskIds: ["b"] },
        ],
        proposal: null,
        applied: null,
      },
      { maxPerDay: 5, sentToday: 0 },
    );
    expect(alert?.params).toEqual({ count: 2, tasks: 2 });
  });
});
