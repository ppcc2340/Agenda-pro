/**
 * Prices in USD per million tokens. Defaults are placeholders for the model ids in `.env.example`; the human who
 * connects the key sets the real ones through AI_PRICES_JSON (docs/blockers/anthropic.md). Never hardcode in callers.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export function parsePrices(json: string | undefined): Record<string, ModelPrice> {
  if (!json) return DEFAULT_PRICES;
  let parsed: Record<string, Partial<Record<keyof ModelPrice, unknown>>>;
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
    parsed = raw as Record<string, Partial<Record<keyof ModelPrice, unknown>>>;
  } catch (err) {
    throw new Error(
      `AI_PRICES_JSON must be a JSON object of model → {input, output, cacheRead, cacheWrite} (docs/blockers/anthropic.md): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const [model, p] of Object.entries(parsed)) {
    out[model] = {
      input: num(p.input),
      output: num(p.output),
      cacheRead: num(p.cacheRead),
      cacheWrite: num(p.cacheWrite),
    };
  }
  return out;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in micro-USD, rounded up so budgets never under-count. */
export function costMicroUsd(model: string, tokens: TokenCounts, prices: Record<string, ModelPrice>): number {
  const p = prices[model] ??
    prices[Object.keys(prices).find((k) => model.startsWith(k)) ?? ""] ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  const usd =
    (tokens.inputTokens * p.input +
      tokens.outputTokens * p.output +
      tokens.cacheReadTokens * p.cacheRead +
      tokens.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return Math.ceil(usd * 1_000_000);
}
