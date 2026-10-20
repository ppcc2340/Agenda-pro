import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIGURE_METHODS, VALUE_EVENT_TYPES, VALUE_METHODS, buildValueReport, type ValueEventInput } from "./report";

const range = { from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-26T00:00:00Z") };
const ev = (over: Partial<ValueEventInput>): ValueEventInput => ({
  type: "commitment_saved",
  entityType: "commitment",
  entityId: "c1",
  quantity: 1,
  method: "commitment_fulfilled_on_time",
  occurredAt: new Date("2026-10-20T10:00:00Z"),
  label: "Enviar el contrato",
  ...over,
});

describe("buildValueReport (F-12 AC1, D-063)", () => {
  it("each method belongs to exactly one figure", () => {
    const all = Object.values(FIGURE_METHODS).flat();
    expect([...all].sort()).toEqual([...VALUE_METHODS].sort());
  });
  it("without events every figure is null with no method and no source: nothing is invented", () => {
    const report = buildValueReport([], range);
    expect(report.figures.map((f) => [f.key, f.value, f.sources.length, f.methods.length])).toEqual([
      ["commitments_saved", null, 0, 0],
      ["deadline_risks_flagged", null, 0, 0],
      ["hours_recovered", null, 0, 0],
    ]);
  });

  it("each figure sums its events, cites every source and lists the methods used; hours are estimated", () => {
    const report = buildValueReport(
      [
        ev({}),
        ev({ entityId: "c2", method: "commitment_fulfilled_after_followup" }),
        ev({ type: "deadline_risk_flagged", entityType: "task", entityId: "t1", method: "task_flagged_at_risk_by_planner" }),
        ev({ type: "untracked_time_recovered", entityType: "time_entry", entityId: "e1", quantity: 54, method: "inferred_time_approved" }),
        ev({ type: "untracked_time_recovered", entityType: "time_entry", entityId: "e2", quantity: 90, method: "inferred_time_approved" }),
      ],
      range,
    );
    const [saved, risks, hours] = report.figures;
    expect(saved).toMatchObject({ value: 2, unit: "commitments", methods: ["commitment_fulfilled_on_time", "commitment_fulfilled_after_followup"], estimated: false });
    expect(saved?.sources.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(risks).toMatchObject({ value: 1, unit: "deadlines", methods: ["task_flagged_at_risk_by_planner"] });
    expect(hours).toMatchObject({ value: 2.4, unit: "hours", estimated: true, methods: ["inferred_time_approved"] });
  });

  it("ignores events outside the range and counts an entity once even if the event was recorded twice", () => {
    const report = buildValueReport(
      [ev({}), ev({}), ev({ entityId: "old", occurredAt: new Date("2026-10-18T23:59:59Z") }), ev({ entityId: "next", occurredAt: range.to })],
      range,
    );
    expect(report.figures[0]).toMatchObject({ value: 1 });
    expect(report.figures[0]?.sources).toHaveLength(1);
  });

  it("property: a figure is non-null exactly when it has sources, and its value is derived only from them", () => {
    const arbEvent = fc.record({
      type: fc.constantFrom(...VALUE_EVENT_TYPES),
      entityType: fc.constantFrom("task", "commitment", "time_entry"),
      entityId: fc.constantFrom("a", "b", "c", "d"),
      quantity: fc.integer({ min: 1, max: 240 }),
      method: fc.constantFrom(...VALUE_METHODS),
      occurredAt: fc.date({ min: new Date("2026-10-15T00:00:00Z"), max: new Date("2026-10-30T00:00:00Z"), noInvalidDate: true }),
      label: fc.constant(null),
    });
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 30 }), (events) => {
        for (const f of buildValueReport(events, range).figures) {
          expect(f.value === null).toBe(f.sources.length === 0);
          if (f.value === null) continue;
          const total = f.sources.reduce((s, x) => s + x.quantity, 0);
          expect(f.value).toBe(f.unit === "hours" ? Math.round((total / 60) * 10) / 10 : total);
          for (const s of f.sources) {
            const t = new Date(s.occurredAt).getTime();
            expect(t >= range.from.getTime() && t < range.to.getTime()).toBe(true);
            expect(f.methods).toContain(s.method);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
