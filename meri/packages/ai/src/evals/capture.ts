/**
 * Capture evals (F-02 AC2): ≥ 85 % of the cases must match the expected fields. Runs against the rules parser and
 * against the fake AI client (same cases); against Anthropic once `AI_MODE=live` (phase 2, same runner).
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localDateKey, type CaptureContext, type CaptureSuggestion } from "@meri/core";
import { FakeAiClient, type AiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "../fake-handlers";
import { suggestCapture } from "../capture";

export interface CaptureCase {
  id: string;
  lang: "es" | "en";
  text: string;
  expected: {
    title?: string;
    clientName?: string | null;
    dueDate?: string | null;
    estimateMinutes?: number | null;
    priority?: number | null;
    kind?: "deep" | "shallow" | null;
  };
}

export interface CaseResult {
  id: string;
  pass: boolean;
  mismatches: string[];
}

export const EVAL_CONTEXT: CaptureContext = {
  now: "2026-10-19T13:40:00Z",
  timezone: "America/Santiago",
  clients: [
    { id: "c1", name: "Acme Corp" },
    { id: "c2", name: "Estudio Norte" },
    { id: "c3", name: "Beta Logística" },
  ],
};

export function loadCases(file: string): CaptureCase[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CaptureCase);
}

export function scoreCase(c: CaptureCase, s: CaptureSuggestion, timezone: string): CaseResult {
  const mismatches: string[] = [];
  const e = c.expected;
  if (e.title !== undefined && s.title !== e.title) mismatches.push(`title: ${s.title}`);
  if (e.clientName !== undefined && (s.clientName ?? null) !== e.clientName)
    mismatches.push(`client: ${String(s.clientName)}`);
  if (e.dueDate !== undefined) {
    const got = s.dueAt ? localDateKey(new Date(s.dueAt).getTime(), timezone) : null;
    if (got !== e.dueDate) mismatches.push(`dueDate: ${String(got)}`);
  }
  if (e.estimateMinutes !== undefined && (s.estimateMinutes ?? null) !== e.estimateMinutes)
    mismatches.push(`estimate: ${String(s.estimateMinutes)}`);
  if (e.priority !== undefined && (s.priority ?? null) !== e.priority)
    mismatches.push(`priority: ${String(s.priority)}`);
  if (e.kind !== undefined && (s.kind ?? null) !== e.kind) mismatches.push(`kind: ${String(s.kind)}`);
  return { id: c.id, pass: mismatches.length === 0, mismatches };
}

export async function runCaptureEval(
  cases: CaptureCase[],
  options: { ai: AiClient | null; useAi: boolean },
): Promise<{ results: CaseResult[]; accuracy: number }> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const { suggestion } = await suggestCapture(c.text, EVAL_CONTEXT, options);
    results.push(scoreCase(c, suggestion, EVAL_CONTEXT.timezone));
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, accuracy: cases.length === 0 ? 0 : passed / cases.length };
}

export const CAPTURE_THRESHOLD = 0.85;

/** CLI entry: `pnpm eval` (writes evals/reports/capture.json, exits 1 under the threshold). */
export async function main(root: string): Promise<void> {
  const cases = loadCases(resolve(root, "evals/capture/seed.jsonl"));
  const fake = new FakeAiClient();
  registerFakeAiHandlers(fake);
  const rules = await runCaptureEval(cases, { ai: null, useAi: false });
  const ai = await runCaptureEval(cases, { ai: fake, useAi: true });
  const report = {
    generatedAt: new Date().toISOString(),
    cases: cases.length,
    threshold: CAPTURE_THRESHOLD,
    rules: { accuracy: rules.accuracy, failed: rules.results.filter((r) => !r.pass) },
    ai: { mode: "fake", accuracy: ai.accuracy, failed: ai.results.filter((r) => !r.pass) },
  };
  mkdirSync(resolve(root, "evals/reports"), { recursive: true });
  writeFileSync(resolve(root, "evals/reports/capture.json"), JSON.stringify(report, null, 2));
  console.warn(
    `capture evals: rules ${(rules.accuracy * 100).toFixed(1)} % · ai(fake) ${(ai.accuracy * 100).toFixed(1)} % (threshold ${String(CAPTURE_THRESHOLD * 100)} %, ${String(cases.length)} cases)`,
  );
  for (const r of rules.results.filter((x) => !x.pass))
    console.warn(`  rules ✗ ${r.id}: ${r.mismatches.join(", ")}`);
  if (rules.accuracy < CAPTURE_THRESHOLD || ai.accuracy < CAPTURE_THRESHOLD) process.exit(1);
}
