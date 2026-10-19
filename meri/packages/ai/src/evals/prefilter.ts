/** Prefilter evals (F-07 AC4): ≥ 95 % of automated mail discarded by rules, 100 % of people mail kept. */
import { resolve } from "node:path";
import { prefilterMessage, type PrefilterMessage } from "@meri/core";
import { loadJsonl } from "./shared";

export interface AutomatedCase {
  id: string;
  message: PrefilterMessage;
  expected: { keep: boolean };
}

export const PREFILTER_FILE = "evals/commitments/automated.jsonl";
export const PREFILTER_DISCARD_THRESHOLD = 0.95;

export function runPrefilterEval(cases: AutomatedCase[]): {
  discardRate: number;
  keepRate: number;
  failed: { id: string; from: string; keep: boolean; reason: string | null }[];
} {
  const failed: { id: string; from: string; keep: boolean; reason: string | null }[] = [];
  let automated = 0;
  let discarded = 0;
  let people = 0;
  let kept = 0;
  for (const c of cases) {
    const r = prefilterMessage(c.message, []);
    if (c.expected.keep) {
      people++;
      if (r.keep) kept++;
      else failed.push({ id: c.id, from: c.message.from, keep: r.keep, reason: r.reason });
    } else {
      automated++;
      if (!r.keep) discarded++;
      else failed.push({ id: c.id, from: c.message.from, keep: r.keep, reason: r.reason });
    }
  }
  return {
    discardRate: automated === 0 ? 1 : discarded / automated,
    keepRate: people === 0 ? 1 : kept / people,
    failed,
  };
}

export function prefilterMain(root: string): boolean {
  const cases = loadJsonl<AutomatedCase>(resolve(root, PREFILTER_FILE));
  const r = runPrefilterEval(cases);
  const ok = r.discardRate >= PREFILTER_DISCARD_THRESHOLD && r.keepRate === 1;
  console.warn(
    `prefilter evals: ${(r.discardRate * 100).toFixed(1)} % automated mail discarded, ${(r.keepRate * 100).toFixed(1)} % people mail kept (${String(cases.length)} cases)${ok ? "" : "  ✗ below threshold"}`,
  );
  for (const f of r.failed)
    console.warn(`  ✗ ${f.id} ${f.from} keep=${String(f.keep)} reason=${String(f.reason)}`);
  return ok;
}
