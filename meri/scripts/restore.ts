/**
 * Restore of a MERI-BACKUP-1 file into an EMPTY database (ADR 0007, docs/runbooks/backup-restore.md): the whole file
 * is authenticated before pg_restore runs, then row counts are compared with the manifest; deletions recorded
 * after the backup are re-applied (docs/compliance/deletion-verification.md).
 * Usage: pnpm restore <file.mbk> --target=<postgres url of an empty database>
 */
import { loadConfig, loadDotenv } from "@meri/config";
import { createIntegrations } from "@meri/integrations";
import { restoreBackup } from "./lib/backup";

async function main(): Promise<void> {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const target = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  if (!file || !target) throw new Error("usage: pnpm restore <file.mbk> --target=<url of an empty database>");
  const kms = createIntegrations(config, { now: () => new Date() }).kms;
  const result = await restoreBackup({ file, targetUrl: target, keys: kms.backupKeys });
  process.stdout.write(
    `restored backup of ${result.manifest.createdAt}: decrypt ${String(result.decryptMs)} ms, restore ${String(result.restoreMs)} ms, ${result.mismatches.length === 0 ? "row counts verified" : `${String(result.mismatches.length)} tables differ`}\n`,
  );
  for (const m of result.mismatches)
    process.stdout.write(`  ${m.table}: expected ${String(m.expected)}, got ${String(m.actual)}\n`);
  if (result.mismatches.length > 0) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("restore.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
