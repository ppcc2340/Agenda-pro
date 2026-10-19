/**
 * Commitment extraction evals (docs/05 §7, F-07 AC1). The runner is the same for the rules extractor (fake client)
 * and for Anthropic once `AI_MODE=live`: it only depends on the `AiClient` interface.
 *
 * Metrics: precision/recall of `explicit` commitments, global precision of proposals, and verifiable evidence
 * (the quote must appear verbatim in the sanitised source). Thresholds are the ones in docs/05 §7.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeMailBody, evidenceAppearsIn } from "@meri/core";
import { FakeAiClient, type AiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "../fake-handlers";
import { extractCommitments, type ExtractedCommitment } from "../extract";
import { actionMatches, EVAL_NOW, EVAL_TZ, loadJsonl } from "./shared";

export interface CommitmentCase {
  id: string;
  lang: "es" | "en";
  template?: string;
  message: { id: string; from: string; to: string[]; date: string; subject?: string; body: string };
  me: string;
  expected: {
    direction: "owed_by_me" | "owed_to_me";
    action: string;
    kind: "explicit" | "inferred" | "suggested";
    dueText?: string | null;
  }[];
}

export interface CommitmentCaseResult {
  id: string;
  template: string | undefined;
  pass: boolean;
  expected: CommitmentCase["expected"];
  got: Pick<ExtractedCommitment, "direction" | "action" | "kind" | "dueText" | "confidence">[];
  missing: CommitmentCase["expected"];
  spurious: CommitmentCaseResult["got"];
  evidenceOk: boolean;
}

export interface CommitmentMetrics {
  cases: number;
  expected: number;
  extracted: number;
  matched: number;
  explicit: { precision: number; recall: number; expected: number; extracted: number; matched: number };
  globalPrecision: number;
  globalRecall: number;
  evidenceVerifiable: number; // fraction of extracted items whose evidence appears in the source
  caseAccuracy: number; // fraction of cases with exactly the expected set
}

export const COMMITMENT_THRESHOLDS = {
  explicitPrecision: 0.9,
  explicitRecall: 0.75,
  globalPrecision: 0.8,
  evidenceVerifiable: 1,
} as const;

export function loadCommitmentCases(files: string[]): CommitmentCase[] {
  return files.flatMap((f) => loadJsonl<CommitmentCase>(f));
}

export async function runCommitmentEval(
  cases: CommitmentCase[],
  ai: AiClient,
): Promise<{ results: CommitmentCaseResult[]; metrics: CommitmentMetrics }> {
  const results: CommitmentCaseResult[] = [];
  let expectedTotal = 0;
  let extractedTotal = 0;
  let matchedTotal = 0;
  let explicitExpected = 0;
  let explicitExtracted = 0;
  let explicitMatched = 0;
  let evidenceOkCount = 0;
  for (const c of cases) {
    const text = sanitizeMailBody(c.message.body);
    const out = await extractCommitments(ai, {
      me: c.me,
      now: EVAL_NOW,
      timezone: EVAL_TZ,
      threadRef: c.id,
      subject: c.message.subject ?? null,
      client: null,
      messages: [{ id: c.message.id, from: c.message.from, to: c.message.to, date: c.message.date, text }],
    });
    const got = out.commitments;
    const unmatchedGot = new Set(got);
    const missing: CommitmentCase["expected"] = [];
    for (const e of c.expected) {
      const hit = [...unmatchedGot].find(
        (g) => g.direction === e.direction && actionMatches(e.action, g.action),
      );
      if (!hit) {
        missing.push(e);
        continue;
      }
      unmatchedGot.delete(hit);
      matchedTotal++;
      if (e.kind === "explicit" && hit.kind === "explicit") explicitMatched++;
    }
    const spurious = [...unmatchedGot];
    const evidenceOk = got.every((g) => evidenceAppearsIn(g.evidence, text));
    evidenceOkCount += got.filter((g) => evidenceAppearsIn(g.evidence, text)).length;
    expectedTotal += c.expected.length;
    extractedTotal += got.length;
    explicitExpected += c.expected.filter((e) => e.kind === "explicit").length;
    explicitExtracted += got.filter((g) => g.kind === "explicit").length;
    const kindsOk = c.expected.every((e) =>
      got.some((g) => g.direction === e.direction && actionMatches(e.action, g.action) && g.kind === e.kind),
    );
    const view = (g: ExtractedCommitment) => ({
      direction: g.direction,
      action: g.action,
      kind: g.kind,
      dueText: g.dueText,
      confidence: g.confidence,
    });
    results.push({
      id: c.id,
      template: c.template,
      pass: missing.length === 0 && spurious.length === 0 && evidenceOk && kindsOk,
      expected: c.expected,
      got: got.map(view),
      missing,
      spurious: spurious.map(view),
      evidenceOk,
    });
  }
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  const metrics: CommitmentMetrics = {
    cases: cases.length,
    expected: expectedTotal,
    extracted: extractedTotal,
    matched: matchedTotal,
    explicit: {
      precision: ratio(explicitMatched, explicitExtracted),
      recall: ratio(explicitMatched, explicitExpected),
      expected: explicitExpected,
      extracted: explicitExtracted,
      matched: explicitMatched,
    },
    globalPrecision: ratio(matchedTotal, extractedTotal),
    globalRecall: ratio(matchedTotal, expectedTotal),
    evidenceVerifiable: ratio(evidenceOkCount, extractedTotal),
    caseAccuracy: ratio(results.filter((r) => r.pass).length, cases.length),
  };
  return { results, metrics };
}

export function meetsCommitmentThresholds(m: CommitmentMetrics): boolean {
  return (
    m.explicit.precision >= COMMITMENT_THRESHOLDS.explicitPrecision &&
    m.explicit.recall >= COMMITMENT_THRESHOLDS.explicitRecall &&
    m.globalPrecision >= COMMITMENT_THRESHOLDS.globalPrecision &&
    m.evidenceVerifiable >= COMMITMENT_THRESHOLDS.evidenceVerifiable
  );
}

export const COMMITMENT_FILES = ["evals/commitments/seed.jsonl", "evals/commitments/generated.jsonl"];

/** CLI step: writes evals/reports/commitments.json and returns whether thresholds are met. */
export async function commitmentsMain(root: string, ai?: AiClient): Promise<boolean> {
  const cases = loadCommitmentCases(COMMITMENT_FILES.map((f) => resolve(root, f)));
  let client = ai;
  if (!client) {
    const fake = new FakeAiClient();
    registerFakeAiHandlers(fake);
    client = fake;
  }
  const { results, metrics } = await runCommitmentEval(cases, client);
  const ok = meetsCommitmentThresholds(metrics);
  const report = {
    generatedAt: new Date().toISOString(),
    ai: client.mode,
    thresholds: COMMITMENT_THRESHOLDS,
    pass: ok,
    metrics,
    failed: results.filter((r) => !r.pass),
  };
  mkdirSync(resolve(root, "evals/reports"), { recursive: true });
  writeFileSync(resolve(root, "evals/reports/commitments.json"), JSON.stringify(report, null, 2));
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
  console.warn(
    `commitment evals (${client.mode}): explicit P ${pct(metrics.explicit.precision)} R ${pct(metrics.explicit.recall)} · global P ${pct(metrics.globalPrecision)} R ${pct(metrics.globalRecall)} · evidence ${pct(metrics.evidenceVerifiable)} · cases ${pct(metrics.caseAccuracy)} (${String(metrics.cases)})${ok ? "" : "  ✗ below threshold"}`,
  );
  for (const r of results.filter((x) => !x.pass).slice(0, 25)) {
    console.warn(
      `  ✗ ${r.id} [${r.template ?? "-"}] missing=${JSON.stringify(r.missing.map((m) => `${m.direction}:${m.action}`))} spurious=${JSON.stringify(r.spurious.map((s) => `${s.direction}:${s.action}:${s.kind}`))} got=${JSON.stringify(r.got.map((g) => `${g.direction}:${g.action}:${g.kind}`))}`,
    );
  }
  return ok;
}
