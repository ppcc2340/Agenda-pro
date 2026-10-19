import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "../fake-handlers";
import { CAPTURE_THRESHOLD, loadCases, runCaptureEval } from "./capture";

const file = resolve(import.meta.dirname, "../../../../evals/capture/seed.jsonl");

describe("capture evals (F-02 AC2)", () => {
  it("rules parser and fake AI reach the 85 % threshold on the seed set", async () => {
    const cases = loadCases(file);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const rules = await runCaptureEval(cases, { ai: null, useAi: false });
    const fake = new FakeAiClient();
    registerFakeAiHandlers(fake);
    const ai = await runCaptureEval(cases, { ai: fake, useAi: true });
    const failed = rules.results.filter((r) => !r.pass).map((r) => `${r.id} ${r.mismatches.join(",")}`);
    expect(rules.accuracy, failed.join(" | ")).toBeGreaterThanOrEqual(CAPTURE_THRESHOLD);
    expect(ai.accuracy).toBeGreaterThanOrEqual(CAPTURE_THRESHOLD);
  });
});
