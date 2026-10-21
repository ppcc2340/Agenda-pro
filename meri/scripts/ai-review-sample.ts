/**
 * pnpm ai:review-sample [--days 7] [--limit 50]
 * Writes evals/candidates/<date>.jsonl for human labelling (D-103). Needs DATABASE_ADMIN_URL. Never commit the file:
 * after labelling, only reviewed, rewritten cases go into evals/ (docs/runbooks/beta.md).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "@meri/config";
import { exportReviewSample } from "./lib/review-sample";

const arg = (args: string[], flag: string): number | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`);
  return n;
};

if (process.argv[1]?.endsWith("ai-review-sample.ts")) {
  loadDotenv(".env");
  const args = process.argv.slice(2);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const outDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "evals", "candidates");
  (adminUrl
    ? exportReviewSample({
        adminUrl,
        now: new Date(),
        outDir,
        ...(arg(args, "--days") ? { days: arg(args, "--days") } : {}),
        ...(arg(args, "--limit") ? { limit: arg(args, "--limit") } : {}),
      })
    : Promise.reject(new Error("DATABASE_ADMIN_URL is required."))
  )
    .then((r) => {
      console.warn(
        r.file
          ? `${String(r.records)} redacted proposals from ${String(r.workspaces)} consenting accounts → ${r.file} (0600)`
          : "nothing to sample (no consenting accounts with discarded or edited non-mail proposals)",
      );
      if (r.pruned) console.warn(`deleted ${String(r.pruned)} sample file(s) older than 30 days`);
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
