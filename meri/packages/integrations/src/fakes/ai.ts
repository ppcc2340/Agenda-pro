import type { z } from "zod";
import { IntegrationError, type HealthReport } from "../errors";
import type { AiClient, StructuredRequest, StructuredResponse } from "../ai/types";

export type FakeAiHandler = (request: { operation: string; system: string; user: string }) => unknown;

/**
 * Deterministic AI stand-in. Each operation maps to a handler (rules-based parsers live in @meri/ai and are
 * registered by the app). Output still goes through the same Zod validation as the live client.
 */
export class FakeAiClient implements AiClient {
  readonly mode = "fake" as const;
  private readonly handlers = new Map<string, FakeAiHandler>();
  readonly calls: { operation: string; model: string; user: string }[] = [];

  register(operation: string, handler: FakeAiHandler): this {
    this.handlers.set(operation, handler);
    return this;
  }

  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({ provider: "anthropic", mode: "fake", status: "healthy", detail: "FakeAiClient" });
  }

  complete<T extends z.ZodTypeAny>(request: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>> {
    const handler = this.handlers.get(request.operation);
    if (!handler) {
      return Promise.reject(new IntegrationError("Permanent", "anthropic", `no fake handler for operation ${request.operation}`));
    }
    this.calls.push({ operation: request.operation, model: request.model, user: request.user });
    const raw = handler({ operation: request.operation, system: request.system, user: request.user });
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      return Promise.reject(
        new IntegrationError("Permanent", "anthropic", `fake output failed schema validation: ${parsed.error.message}`),
      );
    }
    const inputTokens = Math.ceil((request.system.length + request.user.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(raw).length / 4);
    return Promise.resolve({
      output: parsed.data as z.infer<T>,
      usage: { model: `fake-${request.model}`, inputTokens, outputTokens, cachedTokens: 0, costMicroUsd: 0 },
      repaired: false,
    });
  }
}
