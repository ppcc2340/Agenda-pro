/**
 * Value report (F-12, D-063): every figure is a sum over recorded value events, carries the method that produced
 * it and the sources it counts. No events → no figure (null), never an invented zero.
 */
export const VALUE_EVENT_TYPES = ["commitment_saved", "deadline_risk_flagged", "untracked_time_recovered"] as const;
export type ValueEventType = (typeof VALUE_EVENT_TYPES)[number];

/** Stable method codes (translated in the UI); each says how one event was established. */
export const VALUE_METHODS = [
  "commitment_fulfilled_on_time",
  "commitment_fulfilled_after_followup",
  "task_flagged_at_risk_by_planner",
  "third_party_commitment_overdue",
  "inferred_time_approved",
] as const;
export type ValueMethod = (typeof VALUE_METHODS)[number];

export const isValueMethod = (value: string): value is ValueMethod => (VALUE_METHODS as readonly string[]).includes(value);

export interface ValueEventInput {
  type: ValueEventType;
  entityType: string;
  entityId: string;
  /** Minutes for time, 1 for countable events. */
  quantity: number;
  method: ValueMethod;
  occurredAt: Date;
  /** Display label resolved by the caller from the user's own data (task title, client name…). */
  label: string | null;
}

export interface ValueSource {
  type: string;
  id: string;
  label: string | null;
  method: ValueMethod;
  quantity: number;
  occurredAt: string;
}

export interface ValueFigure {
  key: "commitments_saved" | "deadline_risks_flagged" | "hours_recovered";
  /** null when there is no underlying event in the period. */
  value: number | null;
  unit: "commitments" | "deadlines" | "hours";
  /** Methods that contributed, in a stable order (the UI explains each one). */
  methods: ValueMethod[];
  estimated: boolean;
  sources: ValueSource[];
}

export interface ValueReport {
  from: string;
  to: string;
  figures: ValueFigure[];
}

const FIGURES: { key: ValueFigure["key"]; type: ValueEventType; unit: ValueFigure["unit"]; estimated: boolean }[] = [
  { key: "commitments_saved", type: "commitment_saved", unit: "commitments", estimated: false },
  { key: "deadline_risks_flagged", type: "deadline_risk_flagged", unit: "deadlines", estimated: false },
  { key: "hours_recovered", type: "untracked_time_recovered", unit: "hours", estimated: true },
];

/** Aggregates the events of [from, to) into the three figures of the report. */
export function buildValueReport(events: readonly ValueEventInput[], range: { from: Date; to: Date }): ValueReport {
  const inRange = events.filter(
    (e) => e.occurredAt.getTime() >= range.from.getTime() && e.occurredAt.getTime() < range.to.getTime(),
  );
  const figures = FIGURES.map(({ key, type, unit, estimated }): ValueFigure => {
    // One contribution per entity: a duplicated event can never inflate a figure.
    const byEntity = new Map<string, ValueEventInput>();
    for (const e of inRange.filter((x) => x.type === type)) {
      const k = `${e.entityType}:${e.entityId}`;
      if (!byEntity.has(k)) byEntity.set(k, e);
    }
    const counted = [...byEntity.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    if (counted.length === 0) return { key, value: null, unit, methods: [], estimated, sources: [] };
    const total = counted.reduce((sum, e) => sum + Math.max(0, e.quantity), 0);
    const value = unit === "hours" ? Math.round((total / 60) * 10) / 10 : total;
    const methods = VALUE_METHODS.filter((m) => counted.some((e) => e.method === m));
    return {
      key,
      value,
      unit,
      methods,
      estimated,
      sources: counted.map((e) => ({
        type: e.entityType,
        id: e.entityId,
        label: e.label,
        method: e.method,
        quantity: e.quantity,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  });
  return { from: range.from.toISOString(), to: range.to.toISOString(), figures };
}
