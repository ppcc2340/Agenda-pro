/* `pnpm check:migrations`: refuses destructive or security-weakening migrations without a reviewed approval (D-098). */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_MARKER, BASELINE, checkMigration, migrationNumber } from "./lib/migration-check";

const dir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages", "db", "drizzle");
const all = process.argv.includes("--all");
let failed = 0;
for (const file of readdirSync(dir).sort()) {
  const n = migrationNumber(file);
  if (n === null || (!all && n < BASELINE)) continue;
  const report = checkMigration(readFileSync(join(dir, file), "utf8"));
  if (report.findings.length === 0) continue;
  const approved = report.approval !== null;
  console.warn(
    `${approved ? "APPROVED" : "REFUSED "} ${file}${approved ? ` (${report.approval ?? ""})` : ""}`,
  );
  for (const f of report.findings) console.warn(`  [${f.kind}] ${f.rule}: ${f.statement}`);
  if (!approved && n >= BASELINE) failed += 1;
}
if (failed > 0) {
  console.error(
    `\n${String(failed)} migration(s) need a backwards-compatible rewrite (expand/contract, docs/runbooks/deploy.md) ` +
      `or a reviewed exception: "-- ${APPROVAL_MARKER} <reason>" (CODEOWNERS review).`,
  );
  process.exit(1);
}
console.warn(
  `migrations OK (checked from ${String(BASELINE).padStart(4, "0")}${all ? ", history reported" : ""})`,
);
