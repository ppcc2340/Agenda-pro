/**
 * Test support: a realistic demo scenario and fast-check arbitraries that
 * generate valid PlanInput values (DAG dependencies, events inside the horizon,
 * real IANA zones including DST transition weeks). Not part of the runtime API.
 */
import fc from "fast-check";
import { MINUTE_MS, minutesToIso } from "./calendar-math";
import type { FixedEvent, PlanInput, PlannerPreferences, PlannerTask } from "./types";

export const TIMEZONES = [
  "America/Santiago",
  "Europe/Madrid",
  "UTC",
  "America/New_York",
  "Asia/Kolkata",
] as const;

/** Weeks containing DST transitions in Madrid (Mar 29, Oct 25) and Santiago (Apr 5, Sep 6). */
export const BASE_DATES = [
  "2026-10-19T00:00:00.000Z",
  "2026-03-27T00:00:00.000Z",
  "2026-04-03T00:00:00.000Z",
  "2026-09-04T00:00:00.000Z",
  "2026-10-23T00:00:00.000Z",
] as const;

export const DEMO_PREFERENCES: PlannerPreferences = {
  timezone: "Europe/Madrid",
  workStart: "09:00",
  workEnd: "18:00",
  workDays: [1, 2, 3, 4, 5],
  deepWorkWindows: [{ start: "09:00", end: "12:00" }],
  minBlockMinutes: 30,
  minDeepBlockMinutes: 90,
  bufferMinutes: 15,
  contingencyPct: 20,
  riskThresholdHours: 4,
};

/** Monday 2026-10-19 09:00 Madrid (07:00Z); the horizon is that whole week. */
export const DEMO_NOW = "2026-10-19T07:00:00.000Z";
export const DEMO_HORIZON_START = "2026-10-18T22:00:00.000Z";
export const DEMO_HORIZON_END = "2026-10-25T22:00:00.000Z";

export function task(overrides: Partial<PlannerTask> & { id: string }): PlannerTask {
  return {
    title: overrides.id,
    clientId: null,
    priority: 3,
    kind: "shallow",
    estimateMinutes: 60,
    dueAt: null,
    deadlineType: "soft",
    blockedBy: [],
    status: "pending",
    ...overrides,
  };
}

export function event(id: string, startsAt: string, endsAt: string, busy = true): FixedEvent {
  return { id, startsAt, endsAt, busy };
}

export function demoInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    now: DEMO_NOW,
    horizonStart: DEMO_HORIZON_START,
    horizonEnd: DEMO_HORIZON_END,
    tasks: [],
    fixedEvents: [],
    existingBlocks: [],
    preferences: DEMO_PREFERENCES,
    ...overrides,
  };
}

export function isoPlusMinutes(iso: string, minutes: number): string {
  return minutesToIso(Date.parse(iso) / MINUTE_MS + minutes);
}

const preferencesArb: fc.Arbitrary<PlannerPreferences> = fc.record({
  timezone: fc.constantFrom(...TIMEZONES),
  workStart: fc.constantFrom("08:00", "09:00", "09:30"),
  workEnd: fc.constantFrom("17:00", "18:00", "19:30"),
  workDays: fc.subarray([0, 1, 2, 3, 4, 5, 6]),
  deepWorkWindows: fc.constantFrom(
    [],
    [{ start: "09:00", end: "12:00" }],
    [
      { start: "09:00", end: "11:00" },
      { start: "15:00", end: "17:00" },
    ],
  ),
  minBlockMinutes: fc.constantFrom(15, 30),
  minDeepBlockMinutes: fc.constantFrom(45, 60, 90),
  bufferMinutes: fc.constantFrom(0, 5, 15),
  contingencyPct: fc.constantFrom(0, 10, 20, 30),
  riskThresholdHours: fc.constantFrom(0, 2, 4, 8),
});

interface TaskSeed {
  priority: number;
  kind: "deep" | "shallow";
  estimateMinutes: number;
  remainingRatio: number | null;
  dueOffsetMinutes: number | null;
  deadlineType: "soft" | "hard";
  depSeeds: number[];
  status: PlannerTask["status"];
}

const taskSeedArb: fc.Arbitrary<TaskSeed> = fc.record({
  priority: fc.integer({ min: 1, max: 4 }),
  kind: fc.constantFrom("deep", "shallow"),
  estimateMinutes: fc.integer({ min: 3, max: 48 }).map((n) => n * 10),
  remainingRatio: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
  dueOffsetMinutes: fc.option(fc.integer({ min: -600, max: 11 * 1440 }), { nil: null }),
  deadlineType: fc.constantFrom("soft", "hard"),
  depSeeds: fc.array(fc.nat(100), { maxLength: 2 }),
  status: fc.constantFrom(
    "pending",
    "pending",
    "pending",
    "scheduled",
    "in_progress",
    "at_risk",
    "completed",
  ),
});

interface EventSeed {
  offsetMinutes: number;
  durationMinutes: number;
  busy: boolean;
}

const eventSeedArb: fc.Arbitrary<EventSeed> = fc.record({
  offsetMinutes: fc.integer({ min: 0, max: 10 * 1440 }),
  durationMinutes: fc.integer({ min: 15, max: 180 }),
  busy: fc.boolean(),
});

interface InputSeed {
  base: string;
  nowOffsetMinutes: number;
  horizonDays: number;
  preferences: PlannerPreferences;
  tasks: TaskSeed[];
  events: EventSeed[];
}

function buildInput(seed: InputSeed): PlanInput {
  const horizonStart = seed.base;
  const horizonEnd = isoPlusMinutes(seed.base, seed.horizonDays * 1440);
  const now = isoPlusMinutes(seed.base, Math.min(seed.nowOffsetMinutes, seed.horizonDays * 1440 - 1));
  const tasks = seed.tasks.map((t, index): PlannerTask => {
    // Dependencies only point to earlier tasks, so the graph is always a DAG.
    const deps = index === 0 ? [] : [...new Set(t.depSeeds.map((s) => `t${String(s % index)}`))];
    return task({
      id: `t${String(index)}`,
      priority: t.priority,
      kind: t.kind,
      estimateMinutes: t.estimateMinutes,
      ...(t.remainingRatio === null
        ? {}
        : { remainingMinutes: Math.round((t.estimateMinutes * t.remainingRatio) / 100) }),
      dueAt: t.dueOffsetMinutes === null ? null : isoPlusMinutes(now, t.dueOffsetMinutes),
      deadlineType: t.deadlineType,
      blockedBy: deps,
      status: t.status,
    });
  });
  const fixedEvents = seed.events
    .filter((e) => e.offsetMinutes < seed.horizonDays * 1440)
    .map((e, index) =>
      event(
        `e${String(index)}`,
        isoPlusMinutes(horizonStart, e.offsetMinutes),
        isoPlusMinutes(horizonStart, e.offsetMinutes + e.durationMinutes),
        e.busy,
      ),
    );
  return {
    now,
    horizonStart,
    horizonEnd,
    tasks,
    fixedEvents,
    existingBlocks: [],
    preferences: seed.preferences,
  };
}

/** Valid PlanInput values: 1-10 day horizons, up to 8 tasks forming a DAG, up to 5 events. */
export const planInputArb: fc.Arbitrary<PlanInput> = fc
  .record({
    base: fc.constantFrom(...BASE_DATES),
    nowOffsetMinutes: fc.integer({ min: 0, max: 2 * 1440 }),
    horizonDays: fc.integer({ min: 1, max: 10 }),
    preferences: preferencesArb,
    tasks: fc.array(taskSeedArb, { maxLength: 8 }),
    events: fc.array(eventSeedArb, { maxLength: 5 }),
  })
  .map(buildInput);

export interface ExtraTaskSeed {
  priority: number;
  estimateMinutes: number;
  dueOffsetMinutes: number | null;
  deadlineType: "soft" | "hard";
}

/** Seed of a small shallow task to add on top of an existing plan (stability property). */
export const extraTaskSeedArb: fc.Arbitrary<ExtraTaskSeed> = fc.record({
  priority: fc.integer({ min: 1, max: 4 }),
  estimateMinutes: fc.constantFrom(15, 30, 45, 60),
  dueOffsetMinutes: fc.option(fc.integer({ min: 60, max: 5 * 1440 }), { nil: null }),
  deadlineType: fc.constantFrom("soft", "hard"),
});

export function extraTask(seed: ExtraTaskSeed, now: string): PlannerTask {
  return task({
    id: "extra",
    kind: "shallow",
    priority: seed.priority,
    estimateMinutes: seed.estimateMinutes,
    deadlineType: seed.deadlineType,
    dueAt: seed.dueOffsetMinutes === null ? null : isoPlusMinutes(now, seed.dueOffsetMinutes),
  });
}
