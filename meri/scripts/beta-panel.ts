/**
 * pnpm beta:panel [--json] [--min-sample N]   prints the decision panel (D-100)
 * pnpm beta:report [--min-sample N]           writes docs/beta/report-<date>.md, a draft with aggregates only
 * Needs DATABASE_ADMIN_URL (read-only session). WORKER_READY_URL (default http://localhost:4100/ready) adds queues.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "@meri/config";
import { collectPanel, renderReport, renderText } from "./lib/beta-panel";

async function main(): Promise<void> {
  loadDotenv(".env");
  const args = process.argv.slice(2);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required.");
  const minIndex = args.indexOf("--min-sample");
  const minSample = minIndex >= 0 ? Number(args[minIndex + 1]) : undefined;
  if (minSample !== undefined && (!Number.isInteger(minSample) || minSample < 1))
    throw new Error("--min-sample needs a positive integer");
  const result = await collectPanel({
    adminUrl,
    now: new Date(),
    ...(minSample ? { minSample } : {}),
    workerReadyUrl: process.env.WORKER_READY_URL ?? "http://localhost:4100/ready",
  });
  if (args[0] === "report") {
    const dir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "docs", "beta");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `report-${result.generatedAt.slice(0, 10)}.md`);
    writeFileSync(file, renderReport(result), { mode: 0o600 });
    console.warn(`draft written: ${file} (aggregates only; review before sharing)`);
    return;
  }
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
}

if (process.argv[1]?.endsWith("beta-panel.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
