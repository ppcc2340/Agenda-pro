/**
 * `pnpm eval`: capture (F-02), prefilter (F-07 AC4), commitments (F-07 AC1), injection (docs/05 §6) and briefings
 * (F-11 AC2, F-09 AC1) evals.
 * Runs against the fake client (rules) by default; with AI_MODE=live and ANTHROPIC_API_KEY the same runners use
 * the live client (see docs/blockers/anthropic.md). Exits 1 when any suite is under its threshold.
 */
import { resolve } from "node:path";
import { briefingsMain } from "./briefings";
import { main as captureMain } from "./capture";
import { commitmentsMain } from "./commitments";
import { injectionMain } from "./injection";
import { prefilterMain } from "./prefilter";

const root = resolve(import.meta.dirname, "../../../..");

async function run(): Promise<void> {
  await captureMain(root);
  const results = [prefilterMain(root), await commitmentsMain(root), await injectionMain(root), await briefingsMain(root)];
  if (results.some((ok) => !ok)) process.exit(1);
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
