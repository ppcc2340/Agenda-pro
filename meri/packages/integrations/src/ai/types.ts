import type { z } from "zod";
import type { HealthReport } from "../errors";

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
}

export interface StructuredRequest<T extends z.ZodTypeAny> {
  operation: string;
  model: "fast" | "smart";
  /** Stable system prompt (eligible for prompt caching). */
  system: string;
  /** Untrusted content already delimited by the caller (docs/05 §6). */
  user: string;
  schema: T;
  maxTokens?: number;
}

export interface StructuredResponse<T> {
  output: T;
  usage: AiUsage;
  /** True when the first output failed validation and a repair round-trip was needed. */
  repaired: boolean;
}

/** AI client: structured outputs only, no tools with side effects (docs/05 §6.2). */
export interface AiClient {
  readonly mode: "fake" | "live";
  healthCheck(): Promise<HealthReport>;
  complete<T extends z.ZodTypeAny>(request: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>>;
}
