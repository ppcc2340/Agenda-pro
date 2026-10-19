import { z } from "zod";
import { FakeAiClient } from "@meri/integrations";
import { ok, run } from "./_shared";

const Schema = z.object({ answer: z.literal("pong"), confidence: z.number().min(0).max(1) });

await run("anthropic", async ({ integrations }) => {
  const ai = integrations.ai;
  if (ai instanceof FakeAiClient) ai.register("smoke.ping", () => ({ answer: "pong", confidence: 1 }));
  const res = await ai.complete({
    operation: "smoke.ping",
    model: "fast",
    system: "Reply with JSON {answer:'pong', confidence:1}.",
    user: "ping",
    schema: Schema,
  });
  ok(`structured output validated: ${res.output.answer}`);
  ok(`usage: ${String(res.usage.inputTokens)} in / ${String(res.usage.outputTokens)} out tokens, ${String(res.usage.costMicroUsd)} µUSD`);
});
