import { describe, expect, it } from "vitest";
import { findCycle, wouldCreateCycle } from "./dependencies";

const graph = (o: Record<string, string[]>) => ({ blockedBy: new Map(Object.entries(o)) });

describe("dependency cycles (F-03 AC1)", () => {
  it("accepts a DAG and reports null", () => {
    expect(findCycle(graph({ a: ["b", "c"], b: ["c"], c: [] }))).toBeNull();
    expect(findCycle(graph({}))).toBeNull();
  });

  it("finds direct, indirect and self cycles deterministically", () => {
    expect(findCycle(graph({ a: ["b"], b: ["a"] }))).toEqual(["a", "b", "a"]);
    expect(findCycle(graph({ a: ["b"], b: ["c"], c: ["a"] }))).toEqual(["a", "b", "c", "a"]);
    expect(findCycle(graph({ a: ["a"] }))).toEqual(["a", "a"]);
    expect(findCycle(graph({ z: ["y"], y: ["x"], x: ["y"] }))).toEqual(["x", "y", "x"]);
  });

  it("checks a proposed edge set without mutating the graph", () => {
    const g = graph({ a: ["b"], b: [] });
    expect(wouldCreateCycle(g, "b", ["a"])).toEqual(["a", "b", "a"]);
    expect(wouldCreateCycle(g, "b", ["c"])).toBeNull();
    expect(wouldCreateCycle(g, "c", ["c"])).toEqual(["c", "c"]);
    expect(g.blockedBy.get("b")).toEqual([]);
  });
});
