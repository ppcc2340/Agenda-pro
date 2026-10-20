import { describe, expect, it } from "vitest";
import { buildDailyClose, buildWeeklyReview, type ReviewBlock, type ReviewTask } from "./reviews";

const at = (iso: string) => new Date(iso);
const task = (over: Partial<ReviewTask> & { id: string }): ReviewTask => ({
  title: `Tarea ${over.id}`,
  clientId: null,
  status: "scheduled",
  completedAt: null,
  estimateMinutes: 60,
  riskSince: null,
  ...over,
});
const block = (taskId: string, start: string, end: string, done = false): ReviewBlock => ({
  taskId,
  startsAt: at(start),
  endsAt: at(end),
  completedAt: done ? at(end) : null,
});

describe("buildDailyClose (F-12, D-064)", () => {
  const today = { from: at("2026-10-19T22:00:00Z"), to: at("2026-10-20T22:00:00Z") };
  const tomorrow = { from: today.to, to: at("2026-10-21T22:00:00Z") };
  const now = at("2026-10-20T15:00:00Z");
  it("sorts the day into done, pending, to reschedule, blocked, new risks and tomorrow's priorities", () => {
    const tasks = [
      task({ id: "done", status: "completed", completedAt: at("2026-10-20T10:00:00Z") }),
      task({ id: "later" }),
      task({ id: "missed" }),
      task({ id: "wait", status: "waiting_on_third_party" }),
      task({ id: "risky", status: "at_risk", riskSince: at("2026-10-20T07:00:00Z") }),
      task({ id: "oldrisk", status: "at_risk", riskSince: at("2026-10-18T07:00:00Z") }),
      task({ id: "t1" }),
      task({ id: "t2" }),
      task({ id: "t3" }),
      task({ id: "t4" }),
      task({ id: "yesterday", status: "completed", completedAt: at("2026-10-19T10:00:00Z") }),
    ];
    const blocks = [
      block("done", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z", true),
      block("later", "2026-10-20T16:00:00Z", "2026-10-20T17:00:00Z"),
      block("missed", "2026-10-20T11:00:00Z", "2026-10-20T12:00:00Z"),
      block("t2", "2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z"),
      block("t1", "2026-10-21T07:00:00Z", "2026-10-21T08:00:00Z"),
      block("t1", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z"),
      block("t3", "2026-10-21T13:00:00Z", "2026-10-21T14:00:00Z"),
      block("t4", "2026-10-21T15:00:00Z", "2026-10-21T16:00:00Z"),
    ];
    const close = buildDailyClose({ today, tomorrow, now, tasks, blocks });
    const ids = (xs: { taskId: string }[]) => xs.map((x) => x.taskId);
    expect(ids(close.done)).toEqual(["done"]);
    expect(ids(close.pending)).toEqual(["later"]);
    expect(ids(close.toReschedule)).toEqual(["missed"]);
    expect(ids(close.blocked)).toEqual(["wait"]);
    expect(ids(close.newRisks)).toEqual(["risky"]);
    expect(ids(close.tomorrow)).toEqual(["t1", "t2", "t3"]);
    expect(close.tomorrow[0]?.startsAt).toBe("2026-10-21T07:00:00.000Z");
  });
  it("an empty day yields empty sections", () => {
    expect(buildDailyClose({ today, tomorrow, now, tasks: [], blocks: [] })).toEqual({
      done: [], pending: [], toReschedule: [], blocked: [], newRisks: [], tomorrow: [],
    });
  });
});

describe("buildWeeklyReview (F-12, D-064)", () => {
  const days = [
    { day: "2026-10-19", from: at("2026-10-18T22:00:00Z"), to: at("2026-10-19T22:00:00Z"), capacityMinutes: 400 },
    { day: "2026-10-20", from: at("2026-10-19T22:00:00Z"), to: at("2026-10-20T22:00:00Z"), capacityMinutes: 400 },
    { day: "2026-10-25", from: at("2026-10-24T22:00:00Z"), to: at("2026-10-25T22:00:00Z"), capacityMinutes: 0 },
  ];
  it("load per day, totals, estimate versus actual with the median error, and the trend", () => {
    const tasks = [
      task({ id: "a", status: "completed", completedAt: at("2026-10-19T12:00:00Z"), estimateMinutes: 60 }),
      task({ id: "b", status: "completed", completedAt: at("2026-10-20T12:00:00Z"), estimateMinutes: 120 }),
      task({ id: "c", status: "completed", completedAt: at("2026-10-20T13:00:00Z"), estimateMinutes: 30 }),
      task({ id: "noest", status: "completed", completedAt: at("2026-10-20T13:00:00Z"), estimateMinutes: null }),
      task({ id: "open" }),
    ];
    const blocks = [
      block("a", "2026-10-19T08:00:00Z", "2026-10-19T09:30:00Z", true), // 90 vs 60 → +50 %
      block("b", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z", true), // 60 of blocks, approved 120: approved wins → 0 %
      block("open", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"),
    ];
    const review = buildWeeklyReview({
      days,
      tasks,
      blocks,
      // b: the approved entry replaces the block minutes (not 60 + 120); c: only approved time, 24 vs 30 → −20 %.
      approvedMinutesByTask: new Map([["b", 120], ["c", 24]]),
      previous: { plannedMinutes: 200, completedMinutes: 150 },
    });
    expect(review.days.map((d) => [d.day, d.plannedMinutes, d.completedMinutes, d.load])).toEqual([
      ["2026-10-19", 90, 90, 0.23],
      ["2026-10-20", 180, 60, 0.45],
      ["2026-10-25", 0, 0, null],
    ]);
    expect(review.totals).toEqual({ capacityMinutes: 800, plannedMinutes: 270, completedMinutes: 150 });
    expect(review.estimates.map((e) => [e.taskId, e.actualMinutes, e.deltaPct])).toEqual([["a", 90, 50], ["b", 120, 0], ["c", 24, -20]]);
    expect(review.medianEstimateErrorPct).toBe(20);
    expect(review.trend).toEqual({ previousPlannedMinutes: 200, previousCompletedMinutes: 150, plannedDeltaPct: 35 });
  });
  it("without completed estimated work there is no median, and without a previous week no trend", () => {
    const review = buildWeeklyReview({ days, tasks: [], blocks: [], approvedMinutesByTask: new Map(), previous: null });
    expect(review.medianEstimateErrorPct).toBeNull();
    expect(review.trend).toBeNull();
    expect(buildWeeklyReview({ days, tasks: [], blocks: [], approvedMinutesByTask: new Map(), previous: { plannedMinutes: 0, completedMinutes: 0 } }).trend?.plannedDeltaPct).toBeNull();
    const even = buildWeeklyReview({
      days,
      tasks: [
        task({ id: "x", status: "completed", completedAt: at("2026-10-19T12:00:00Z"), estimateMinutes: 100 }),
        task({ id: "y", status: "completed", completedAt: at("2026-10-19T12:00:00Z"), estimateMinutes: 100 }),
      ],
      blocks: [block("x", "2026-10-19T08:00:00Z", "2026-10-19T09:50:00Z", true), block("y", "2026-10-19T10:00:00Z", "2026-10-19T12:10:00Z", true)],
      approvedMinutesByTask: new Map(),
      previous: null,
    });
    expect(even.medianEstimateErrorPct).toBe(20); // |10| and |30| → 20
  });
});
