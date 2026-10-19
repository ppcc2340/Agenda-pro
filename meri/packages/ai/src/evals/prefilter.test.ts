import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREFILTER_DISCARD_THRESHOLD,
  PREFILTER_FILE,
  runPrefilterEval,
  type AutomatedCase,
} from "./prefilter";
import { loadJsonl } from "./shared";

const root = resolve(import.meta.dirname, "../../../..");

describe("prefilter evals (F-07 AC4)", () => {
  it("discards ≥ 95 % of automated mail and keeps 100 % of people mail", () => {
    const cases = loadJsonl<AutomatedCase>(resolve(root, PREFILTER_FILE));
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const r = runPrefilterEval(cases);
    expect(r.discardRate, JSON.stringify(r.failed)).toBeGreaterThanOrEqual(PREFILTER_DISCARD_THRESHOLD);
    expect(r.keepRate).toBe(1);
  });
});
