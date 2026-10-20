/**
 * Encrypted logical backup (ADR 0007, docs/runbooks/backup-restore.md): pg_dump under the admin read context, then
 * MERI-BACKUP-1 with a fresh data key wrapped by the KMS `backup` key ring. Prints sizes, counts and the key id only.
 * Usage: pnpm backup [--out=backups/meri-<timestamp>.mbk]   (needs DATABASE_ADMIN_URL)
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, loadDotenv } from "@meri/config";
import { createIntegrations } from "@meri/integrations";
import { createBackup } from "./lib/backup";

async function main(): Promise<void> {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  if (!config.env.DATABASE_ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required for backups.");
  const now = new Date();
  const out =
    process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length) ??
    `backups/meri-${now.toISOString().replace(/[:.]/g, "-")}.mbk`;
  await mkdir(dirname(out), { recursive: true });
  const kms = createIntegrations(config, { now: () => now }).kms;
  const result = await createBackup({ adminUrl: config.env.DATABASE_ADMIN_URL, keys: kms.backupKeys, out, now });
  const rows = Object.values(result.manifest.tables).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `backup written to ${result.path}: ${String(Object.keys(result.manifest.tables).length)} tables, ${String(rows)} rows, ${String(result.bytes)} bytes, key ${result.keyId}, dump ${String(result.dumpMs)} ms, encrypt ${String(result.encryptMs)} ms\n`,
  );
}

if (process.argv[1]?.endsWith("backup.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
