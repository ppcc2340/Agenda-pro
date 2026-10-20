import { describe, expect, it } from "vitest";
import { isOverdue } from "./commitments";

describe("isOverdue", () => {
  const now = new Date("2026-10-20T08:40:00Z");
  it("is overdue when flagged at risk or confirmed past its due date, never when proposed or undated", () => {
    expect(isOverdue({ status: "at_risk", dueAt: null }, now)).toBe(true);
    expect(isOverdue({ status: "confirmed", dueAt: "2026-10-19T18:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ status: "confirmed", dueAt: "2026-10-21T18:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "confirmed", dueAt: null }, now)).toBe(false);
    expect(isOverdue({ status: "proposed", dueAt: "2026-10-19T18:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "fulfilled", dueAt: "2026-10-19T18:00:00Z" }, now)).toBe(false);
  });
});
