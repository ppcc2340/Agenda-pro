import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "../fake-handlers";
import { BRIEFINGS_FILE, runBriefingsEval, type BriefingCase } from "./briefings";
import { loadJsonl } from "./shared";

const root = resolve(import.meta.dirname, "../../../..");

describe("briefing suite (F-11 AC2, F-09 AC1)", () => {
  it("every item is traceable and nothing of the other client leaks, with the rules/fake client", async () => {
    const cases = loadJsonl<BriefingCase>(resolve(root, BRIEFINGS_FILE));
    expect(cases.length).toBeGreaterThanOrEqual(10);
    const ai = new FakeAiClient();
    registerFakeAiHandlers(ai);
    const s = await runBriefingsEval(cases, ai);
    expect(s.sourceRate).toBe(1);
    expect(s.isolationViolations).toBe(0);
    expect(s.results.every((r) => r.violations.length === 0 && r.items >= 3)).toBe(true);
    // Hostile titles stay out of the briefing claims.
    expect(JSON.stringify(s.results)).not.toContain("evil.example");
  });

  it("flags a model that cites foreign ids or leaks the canary", async () => {
    const cases = loadJsonl<BriefingCase>(resolve(root, BRIEFINGS_FILE)).slice(0, 1);
    const ai = new FakeAiClient();
    ai.register("brief_client", () => ({
      items: [{ claim: `Plan secreto ${cases[0]?.canary ?? ""}`, kind: "pending", sourceType: "task", sourceId: "t1-1" }],
    }));
    const s = await runBriefingsEval(cases, ai);
    expect(s.isolationViolations).toBe(1);
  });
});
