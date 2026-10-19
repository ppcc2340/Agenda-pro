import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "../fake-handlers";
import {
  COMMITMENT_FILES,
  COMMITMENT_THRESHOLDS,
  loadCommitmentCases,
  meetsCommitmentThresholds,
  runCommitmentEval,
} from "./commitments";

const root = resolve(import.meta.dirname, "../../../..");

describe("commitment evals (F-07 AC1, docs/05 §7)", () => {
  it("≥ 200 es/en cases and the rules extractor (fake client) meets every threshold", async () => {
    const cases = loadCommitmentCases(COMMITMENT_FILES.map((f) => resolve(root, f)));
    expect(cases.length).toBeGreaterThanOrEqual(200);
    expect(cases.filter((c) => c.lang === "es").length).toBeGreaterThanOrEqual(80);
    expect(cases.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(80);
    const ai = new FakeAiClient();
    registerFakeAiHandlers(ai);
    const { results, metrics } = await runCommitmentEval(cases, ai);
    const failed = results
      .filter((r) => !r.pass)
      .map((r) => `${r.id}: missing ${String(r.missing.length)} spurious ${String(r.spurious.length)}`);
    expect(metrics.explicit.precision, failed.join(" | ")).toBeGreaterThanOrEqual(
      COMMITMENT_THRESHOLDS.explicitPrecision,
    );
    expect(metrics.explicit.recall).toBeGreaterThanOrEqual(COMMITMENT_THRESHOLDS.explicitRecall);
    expect(metrics.globalPrecision).toBeGreaterThanOrEqual(COMMITMENT_THRESHOLDS.globalPrecision);
    expect(metrics.evidenceVerifiable).toBe(1);
    expect(meetsCommitmentThresholds(metrics)).toBe(true);
  });

  it("scores a wrong direction, a missing item and a spurious one as failures", async () => {
    const ai = new FakeAiClient();
    ai.register("extract_commitments", () => ({
      commitments: [
        {
          direction: "owed_by_me",
          counterpartyEmail: "ana@acme.example",
          action: "enviar contrato",
          dueAt: null,
          dueText: null,
          kind: "inferred",
          confidence: 0.7,
          evidence: "te envío el contrato",
          externalMessageId: "m1",
        },
      ],
    }));
    const { results, metrics } = await runCommitmentEval(
      [
        {
          id: "x",
          lang: "es",
          me: "yo@mifirma.example",
          message: {
            id: "m1",
            from: "ana@acme.example",
            to: ["yo@mifirma.example"],
            date: "2026-10-12T10:00:00Z",
            body: "Hola, te envío el contrato el lunes.",
          },
          expected: [{ direction: "owed_to_me", action: "enviar contrato", kind: "explicit" }],
        },
      ],
      ai,
    );
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.missing).toHaveLength(1);
    expect(results[0]?.spurious).toHaveLength(1);
    expect(metrics.globalPrecision).toBe(0);
    expect(metrics.explicit.recall).toBe(0);
  });
});
