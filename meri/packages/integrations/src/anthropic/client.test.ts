import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IntegrationError } from "../errors";
import { zodToJsonSchema } from "../ai/json-schema";
import { AnthropicAiClient, OUTPUT_TOOL } from "./client";
import { costMicroUsd, parsePrices } from "./prices";

const Schema = z.object({
  commitments: z
    .array(
      z.object({
        action: z.string().min(3),
        confidence: z.number().min(0).max(1),
        kind: z.enum(["explicit", "inferred"]),
      }),
    )
    .max(10),
});

type Call = { url: string; body: Record<string, unknown> };
function fakeTransport(responses: (() => Response)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === "string" ? init.body : "{}";
    calls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return Promise.resolve(next());
  };
  return { fetch: fetchImpl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const toolReply = (
  input: unknown,
  usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 0,
  },
) =>
  json(200, {
    content: [{ type: "tool_use", id: "tu_1", name: OUTPUT_TOOL, input }],
    usage,
    stop_reason: "tool_use",
  });

const client = (responses: (() => Response)[]) => {
  const t = fakeTransport(responses);
  const c = new AnthropicAiClient({
    apiKey: "sk-test",
    models: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
    fetch: t.fetch,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { c, calls: t.calls };
};

describe("AnthropicAiClient (P2-04)", () => {
  it("sends a cached system prompt, a single output tool with the Zod schema, and accounts tokens and cost", async () => {
    const { c, calls } = client([
      () => toolReply({ commitments: [{ action: "enviar contrato", confidence: 0.9, kind: "explicit" }] }),
    ]);
    const res = await c.complete({
      operation: "extract_commitments",
      model: "fast",
      system: "SYS",
      user: "<thread>…</thread>",
      schema: Schema,
      maxTokens: 300,
    });
    expect(res.output.commitments[0]?.action).toBe("enviar contrato");
    expect(res.repaired).toBe(false);
    expect(res.usage).toMatchObject({
      model: "claude-haiku-5-5",
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 400,
    });
    // 1000 input × $1 + 100 output × $5 + 400 cached × $0.1 per MTok = 0.0015 + 0.0005 + 0.00004 USD = 1540 µUSD
    expect(res.usage.costMicroUsd).toBe(1540);
    const body = calls[0]?.body as {
      system: { cache_control: unknown }[];
      tools: { name: string; input_schema: unknown }[];
      tool_choice: unknown;
      messages: unknown[];
    };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.input_schema).toEqual(zodToJsonSchema(Schema));
    expect(body.tool_choice).toEqual({ type: "tool", name: OUTPUT_TOOL });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("repairs once when the output fails validation, then gives up with a Permanent error", async () => {
    const bad = { commitments: [{ action: "x", confidence: 2, kind: "explicit" }] };
    const { c, calls } = client([() => toolReply(bad), () => toolReply({ commitments: [] })]);
    const res = await c.complete({ operation: "op", model: "smart", system: "S", user: "U", schema: Schema });
    expect(res.repaired).toBe(true);
    expect(res.output.commitments).toEqual([]);
    expect(res.usage.inputTokens).toBe(2000); // both rounds accounted
    const second = calls[1]?.body as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toHaveLength(3);
    expect(JSON.stringify(second.messages[2])).toContain("Validation failed");

    const { c: c2 } = client([() => toolReply(bad), () => toolReply(bad)]);
    await expect(
      c2.complete({ operation: "op", model: "fast", system: "S", user: "U", schema: Schema }),
    ).rejects.toMatchObject({ kind: "Permanent" });
  });

  it("retries 429 and 5xx with backoff (honouring retry-after) and maps 401 to a permanent error", async () => {
    const { c, calls } = client([
      () => json(429, { error: "rate" }, { "retry-after": "1" }),
      () => json(503, { error: "down" }),
      () => toolReply({ commitments: [] }),
    ]);
    const res = await c.complete({ operation: "op", model: "fast", system: "S", user: "U", schema: Schema });
    expect(res.output.commitments).toEqual([]);
    expect(calls).toHaveLength(3);
    const { c: c2 } = client([() => json(401, { error: "bad key" })]);
    await expect(
      c2.complete({ operation: "op", model: "fast", system: "S", user: "U", schema: Schema }),
    ).rejects.toBeInstanceOf(IntegrationError);
    const { c: c3 } = client([
      () => json(429, {}),
      () => json(429, {}),
      () => json(429, {}),
      () => json(429, {}),
    ]);
    await expect(
      c3.complete({ operation: "op", model: "fast", system: "S", user: "U", schema: Schema }),
    ).rejects.toMatchObject({ kind: "RateLimited" });
  });

  it("prices come from AI_PRICES_JSON with defaults as fallback", () => {
    const prices = parsePrices('{"claude-haiku-5-5":{"input":0.8,"output":4}}');
    expect(prices["claude-haiku-5-5"]).toEqual({ input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 });
    expect(prices["claude-sonnet-5-5"]?.input).toBe(3);
    expect(
      costMicroUsd(
        "claude-haiku-5-5",
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        prices,
      ),
    ).toBe(800_000);
    expect(
      costMicroUsd(
        "unknown-model",
        { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        prices,
      ),
    ).toBe(0);
  });

  it("converts the real output schemas to JSON Schema", () => {
    const s = zodToJsonSchema(
      z.object({
        a: z.string().email().nullable(),
        b: z.number().int().min(1).max(4).optional(),
        c: z.array(z.enum(["x", "y"])).max(3),
        d: z.record(z.string()),
      }),
    );
    expect(s).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["a", "c", "d"],
      properties: {
        a: { anyOf: [{ type: "string", format: "email" }, { type: "null" }] },
        b: { type: "integer", minimum: 1, maximum: 4 },
        c: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 3 },
        d: { type: "object", additionalProperties: { type: "string" } },
      },
    });
  });
});
