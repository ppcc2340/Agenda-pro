/**
 * Live Anthropic client (docs/05 §2, §5, §6): Messages API over fetch, structured output through a single tool with
 * a JSON Schema derived from Zod, prompt caching on the system prompt, one repair round on validation failure,
 * retries with backoff on 429/5xx/network, token and cost accounting. No tools with side effects, ever.
 */
import { z } from "zod";
import { IntegrationError, type HealthReport } from "../errors";
import type { AiClient, AiUsage, StructuredRequest, StructuredResponse } from "../ai/types";
import { zodToJsonSchema } from "../ai/json-schema";
import { costMicroUsd, DEFAULT_PRICES, type ModelPrice } from "./prices";

export interface AnthropicClientOptions {
  apiKey: string;
  models: { fast: string; smart: string };
  prices?: Record<string, ModelPrice>;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  /** Injected for deterministic backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Per-request timeout (docs/12 §3: every external I/O has one). */
  timeoutMs?: number;
}

/** The parts of the Messages API response we rely on; anything else is ignored, a mismatch is Permanent. */
const MessagesResponseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  }),
  stop_reason: z.string().nullable().optional(),
});
type MessagesResponse = z.infer<typeof MessagesResponseSchema>;

export const ANTHROPIC_VERSION = "2023-06-01";
export const OUTPUT_TOOL = "emit_result";

export class AnthropicAiClient implements AiClient {
  readonly mode = "live" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly prices: Record<string, ModelPrice>;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: AnthropicClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.prices = options.prices ?? DEFAULT_PRICES;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      return {
        provider: "anthropic",
        mode: "live",
        status: res.ok ? "healthy" : "degraded",
        detail: `HTTP ${String(res.status)}`,
      };
    } catch (err) {
      return {
        provider: "anthropic",
        mode: "live",
        status: "degraded",
        detail: err instanceof Error ? err.message : "unreachable",
      };
    }
  }

  async complete<T extends z.ZodTypeAny>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResponse<z.infer<T>>> {
    const model = request.model === "fast" ? this.options.models.fast : this.options.models.smart;
    const tool = {
      name: OUTPUT_TOOL,
      description: "Return the structured result. This is the only allowed action.",
      input_schema: zodToJsonSchema(request.schema),
    };
    const messages: { role: "user" | "assistant"; content: unknown }[] = [
      { role: "user", content: request.user },
    ];
    const usage: AiUsage = { model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicroUsd: 0 };
    let repaired = false;
    for (let round = 0; round < 2; round++) {
      const response = await this.send({
        model,
        max_tokens: request.maxTokens ?? 1024,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        tools: [tool],
        tool_choice: { type: "tool", name: OUTPUT_TOOL },
        messages,
      }, request.signal);
      this.account(usage, model, response);
      const toolUse = response.content.find(
        (c): c is Extract<MessagesResponse["content"][number], { type: "tool_use" }> => c.type === "tool_use",
      );
      const parsed = toolUse ? request.schema.safeParse(toolUse.input) : null;
      if (parsed?.success) return { output: parsed.data as z.infer<T>, usage, repaired };
      // One repair round (docs/05 §1): show the validation issues, ask for a corrected tool call.
      if (round === 1) break;
      repaired = true;
      const issues = parsed
        ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : "no tool call";
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: toolUse
          ? [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Validation failed: ${issues}. Call ${OUTPUT_TOOL} again with a corrected input.`,
                is_error: true,
              },
            ]
          : `No ${OUTPUT_TOOL} call was produced. Call ${OUTPUT_TOOL} with the result.`,
      });
    }
    throw new IntegrationError(
      "Permanent",
      "anthropic",
      `structured output failed validation after repair (${request.operation})`,
    );
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.options.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
  }

  private account(usage: AiUsage, model: string, response: MessagesResponse): void {
    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cachedTokens += cacheRead;
    usage.costMicroUsd += costMicroUsd(
      model,
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      },
      this.prices,
    );
  }

  private async send(body: unknown, signal?: AbortSignal): Promise<MessagesResponse> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= this.maxRetries)
          throw new IntegrationError(
            "Transient",
            "anthropic",
            err instanceof Error ? err.message : "network error",
          );
        await this.sleep(this.backoff(attempt++, null));
        continue;
      }
      if (res.ok) {
        const parsed = MessagesResponseSchema.safeParse(await res.json());
        if (!parsed.success)
          throw new IntegrationError(
            "Permanent",
            "anthropic",
            `unexpected response shape: ${parsed.error.message}`,
          );
        return parsed.data;
      }
      const retryAfter = Number(res.headers.get("retry-after") ?? "") || null;
      if (res.status === 429 || res.status >= 500 || res.status === 408) {
        if (attempt >= this.maxRetries) {
          throw new IntegrationError(
            res.status === 429 ? "RateLimited" : "Transient",
            "anthropic",
            `HTTP ${String(res.status)} after ${String(attempt)} retries`,
          );
        }
        await this.sleep(this.backoff(attempt++, retryAfter));
        continue;
      }
      if (res.status === 401 || res.status === 403)
        throw new IntegrationError(
          "Permanent",
          "anthropic",
          `HTTP ${String(res.status)}: invalid API key or forbidden`,
        );
      throw new IntegrationError("Permanent", "anthropic", `HTTP ${String(res.status)}`);
    }
  }

  private backoff(attempt: number, retryAfterSeconds: number | null): number {
    if (retryAfterSeconds) return Math.min(retryAfterSeconds * 1000, 30_000);
    const base = 500 * 2 ** attempt;
    return Math.min(base + this.random() * base, 20_000);
  }
}
