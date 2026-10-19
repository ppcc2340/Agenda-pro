import { describe, expect, it } from "vitest";
import { FakeAiClient } from "@meri/integrations";
import { suggestCapture } from "./capture";
import { registerFakeAiHandlers } from "./fake-handlers";

const ctx = {
  now: "2026-10-19T13:40:00Z",
  timezone: "America/Santiago",
  clients: [{ id: "c1", name: "Acme Corp" }],
};

describe("suggestCapture (AI-1 behind flag)", () => {
  it("uses the rules only when the flag is off", async () => {
    const r = await suggestCapture("Informe para Acme el jueves, 2 h", ctx, {
      ai: new FakeAiClient(),
      useAi: false,
    });
    expect(r.source).toBe("rules");
    expect(r.suggestion).toMatchObject({ clientId: "c1", estimateMinutes: 120 });
  });

  it("refines with the AI client (fake: same rules) and validates the structured output", async () => {
    const ai = new FakeAiClient();
    registerFakeAiHandlers(ai);
    const r = await suggestCapture("Informe para Acme el jueves, 2 h", ctx, { ai, useAi: true });
    expect(r.source).toBe("ai");
    expect(r.suggestion).toMatchObject({
      clientId: "c1",
      clientName: "Acme Corp",
      title: "Informe para Acme",
      estimateMinutes: 120,
      kind: "deep",
    });
    expect(r.suggestion.confidence).toBeGreaterThanOrEqual(0.8);
    expect(ai.calls[0]?.user).toContain("<capture>");
    expect(ai.calls[0]?.user).not.toContain("c1"); // only names, never internal ids
  });

  it("ignores an AI client that names an unknown client", async () => {
    const ai = new FakeAiClient().register("capture.parse", () => ({
      title: "X",
      clientName: "Evil Corp",
      dueAt: null,
      estimateMinutes: null,
      priority: null,
      kind: null,
    }));
    const r = await suggestCapture("Something", ctx, { ai, useAi: true });
    expect(r.suggestion.clientId).toBeNull();
    expect(r.suggestion.title).toBe("X");
  });
});
