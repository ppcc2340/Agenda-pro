/**
 * AI credits (docs/08 "Créditos de IA", D-061). A credit is a product unit, not a cost: the USD cap and the
 * margin rollup watch the real cost underneath. Pure functions, no I/O.
 */
export const AI_OPERATIONS = [
  "extract_commitments",
  "capture_parse",
  "followup_draft",
  "brief_client",
  "summary",
] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

/** docs/08: mail extraction 1 per thread, natural-language capture 0.2, draft 3, briefing 5, summary 1. */
export const CREDIT_COSTS: Readonly<Record<AiOperation, number>> = {
  extract_commitments: 1,
  capture_parse: 0.2,
  followup_draft: 3,
  brief_client: 5,
  summary: 1,
};

export const isAiOperation = (value: string): value is AiOperation =>
  (AI_OPERATIONS as readonly string[]).includes(value);

/** AI request names that differ from the credit operation they bill (the AI client keeps its own names). */
const REQUEST_ALIASES: Readonly<Record<string, AiOperation>> = { "capture.parse": "capture_parse" };

/** The credit operation an AI request bills, or null for a request that is not billed in credits. */
export function creditOperationOf(requestOperation: string): AiOperation | null {
  if (isAiOperation(requestOperation)) return requestOperation;
  return REQUEST_ALIASES[requestOperation] ?? null;
}

/** Credit packs sold on top of the plan (one-off, valid for the period they are bought in). */
export const CREDIT_PACKS = { "500": 500, "2000": 2000 } as const;
export type CreditPack = keyof typeof CREDIT_PACKS;
export const isCreditPack = (value: string): value is CreditPack => value in CREDIT_PACKS;

/** Credits are counted with two decimals (0.2 per capture) and never in floating noise. */
export const roundCredits = (value: number): number => Math.round(value * 100) / 100;

export interface CreditBalance {
  /** Monthly allowance of the plan plus packs bought this period. */
  allowance: number;
  used: number;
  remaining: number;
  /** used / allowance, 0..∞ (0 when there is no allowance and nothing was used). */
  ratio: number;
}

export function creditBalance(input: { monthly: number; granted: number; used: number }): CreditBalance {
  const allowance = roundCredits(Math.max(0, input.monthly) + Math.max(0, input.granted));
  const used = roundCredits(Math.max(0, input.used));
  const remaining = roundCredits(Math.max(0, allowance - used));
  const ratio = allowance > 0 ? used / allowance : used > 0 ? Number.POSITIVE_INFINITY : 0;
  return { allowance, used, remaining, ratio };
}

export type ChargeDecision =
  | { kind: "allow"; cost: number }
  | { kind: "deny"; cost: number; reason: "credits_exhausted" };

/** May an operation of this cost run with this balance? Exactly when the cost fits in what remains. */
export function chargeDecision(balance: CreditBalance, operation: AiOperation, units = 1): ChargeDecision {
  const cost = roundCredits(CREDIT_COSTS[operation] * Math.max(1, units));
  return cost <= balance.remaining + 1e-9 ? { kind: "allow", cost } : { kind: "deny", cost, reason: "credits_exhausted" };
}

export const CREDIT_THRESHOLDS = [0.8, 1] as const;
export type CreditThreshold = (typeof CREDIT_THRESHOLDS)[number];

/** Thresholds crossed by going from `before` to `after` used credits (each fires once per period). */
export function crossedThresholds(allowance: number, before: number, after: number): CreditThreshold[] {
  if (allowance <= 0) return after > before && before === 0 ? [1] : [];
  return CREDIT_THRESHOLDS.filter((t) => before < allowance * t && after >= allowance * t - 1e-9);
}
