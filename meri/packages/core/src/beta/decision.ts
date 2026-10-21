/**
 * Beta decision panel (D-100, docs/09 «Umbrales de decisión»): each indicator with its value, sample size, threshold
 * and verdict, and a global recommendation = the worst verdict among the indicators that have enough data. Pure:
 * the aggregates come from the database (`beta-metrics.ts`); this only decides.
 */
export type Verdict = "advance" | "iterate" | "pivot" | "no_data";

export const INDICATORS = [
  "retention60",
  "trialToPaid",
  "confirmedUnedited",
  "gmailKept30",
  "seanEllisVery",
  "grossMargin",
] as const;
export type IndicatorKey = (typeof INDICATORS)[number];

/** docs/09: «Avanzar» from `advance`, «Iterar» from `iterate`, «Pivotar/Parar» below. Percentages. */
export const THRESHOLDS: Readonly<Record<IndicatorKey, { advance: number; iterate: number }>> = {
  retention60: { advance: 45, iterate: 25 },
  trialToPaid: { advance: 25, iterate: 10 },
  confirmedUnedited: { advance: 60, iterate: 40 },
  gmailKept30: { advance: 80, iterate: 60 },
  seanEllisVery: { advance: 40, iterate: 25 },
  grossMargin: { advance: 70, iterate: 55 },
};

export const DEFAULT_MIN_SAMPLE = 10;

/** A rate: `hits` out of `n`. The margin is a mean percentage over `n` paying users. */
export type IndicatorInput = { hits: number; n: number } | { meanPct: number | null; n: number };

export interface IndicatorResult {
  key: IndicatorKey;
  valuePct: number | null;
  n: number;
  threshold: { advance: number; iterate: number };
  verdict: Verdict;
}

export interface DecisionInput {
  indicators: Record<IndicatorKey, IndicatorInput>;
  /** Informational: retention at 30 and 90 days, and conversion by price cohort (no threshold of their own). */
  extra?: Record<string, { hits: number; n: number }>;
}

export interface DecisionPanel {
  indicators: IndicatorResult[];
  extra: { key: string; valuePct: number | null; n: number }[];
  recommendation: Verdict;
  minSample: number;
}

const pct = (hits: number, n: number) => (n > 0 ? Math.round((hits / n) * 1000) / 10 : null);

export function verdictFor(
  valuePct: number | null,
  n: number,
  key: IndicatorKey,
  minSample: number,
): Verdict {
  if (valuePct === null || n < minSample) return "no_data";
  const t = THRESHOLDS[key];
  if (valuePct >= t.advance) return "advance";
  if (valuePct >= t.iterate) return "iterate";
  return "pivot";
}

const RANK: Record<Exclude<Verdict, "no_data">, number> = { pivot: 0, iterate: 1, advance: 2 };

export function decide(input: DecisionInput, options: { minSample?: number } = {}): DecisionPanel {
  const minSample = Math.max(1, options.minSample ?? DEFAULT_MIN_SAMPLE);
  const indicators = INDICATORS.map((key): IndicatorResult => {
    const raw = input.indicators[key];
    const valuePct =
      "hits" in raw ? pct(raw.hits, raw.n) : raw.meanPct === null ? null : Math.round(raw.meanPct * 10) / 10;
    return {
      key,
      valuePct,
      n: raw.n,
      threshold: THRESHOLDS[key],
      verdict: verdictFor(valuePct, raw.n, key, minSample),
    };
  });
  const decided = indicators
    .map((i) => i.verdict)
    .filter((v): v is Exclude<Verdict, "no_data"> => v !== "no_data");
  const recommendation: Verdict =
    decided.length === 0 ? "no_data" : decided.reduce((worst, v) => (RANK[v] < RANK[worst] ? v : worst));
  const extra = Object.entries(input.extra ?? {}).map(([key, v]) => ({
    key,
    valuePct: pct(v.hits, v.n),
    n: v.n,
  }));
  return { indicators, extra, recommendation, minSample };
}
