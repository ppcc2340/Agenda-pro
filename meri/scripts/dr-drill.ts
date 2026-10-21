/**
 * Disaster-recovery drill (P5-10, docs/runbooks/disaster-recovery.md): backup → restore into a fresh scratch database
 * on the same server → verify row counts → drop it. Measures each step; with --report writes the result to
 * docs/runbooks/dr-drill-<date>.md. Never touches the source database.
 * Usage: pnpm dr:drill [--report]   (needs DATABASE_ADMIN_URL with CREATEDB)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "@meri/config/crypto";
import { loadConfig, loadDotenv } from "@meri/config";
import { createDb } from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { createBackup, restoreBackup } from "./lib/backup";

export interface DrillResult {
  startedAt: string;
  tables: number;
  rows: number;
  bytes: number;
  backupMs: number;
  restoreMs: number;
  totalMs: number;
  verified: boolean;
  mismatches: { table: string; expected: number; actual: number }[];
}

const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export async function runDrill(options: {
  adminUrl: string;
  keys: KeyProvider;
  now: Date;
}): Promise<DrillResult> {
  const work = await mkdtemp(join(tmpdir(), "meri-drill-"));
  const scratch = `meri_drill_${options.now.getTime().toString(36)}_${process.pid.toString(36)}`;
  const admin = createDb(options.adminUrl, { max: 1 });
  const t0 = Date.now();
  let result: DrillResult;
  let dropError: unknown = null;
  try {
    const backup = await createBackup({
      adminUrl: options.adminUrl,
      keys: options.keys,
      out: join(work, "drill.mbk"),
      now: options.now,
    });
    const backupMs = Date.now() - t0;
    await admin.sql.unsafe(`create database "${scratch}"`);
    const t1 = Date.now();
    const restored = await restoreBackup({
      file: backup.path,
      targetUrl: withDatabase(options.adminUrl, scratch),
      keys: options.keys,
    });
    const restoreMs = Date.now() - t1;
    result = {
      startedAt: options.now.toISOString(),
      tables: Object.keys(backup.manifest.tables).length,
      rows: Object.values(backup.manifest.tables).reduce((a, b) => a + b, 0),
      bytes: backup.bytes,
      backupMs,
      restoreMs,
      totalMs: Date.now() - t0,
      verified: restored.mismatches.length === 0,
      mismatches: restored.mismatches,
    };
  } finally {
    // The scratch database is a plaintext copy of production: failing to drop it must be loud, never swallowed.
    try {
      await admin.sql.unsafe(`drop database if exists "${scratch}" with (force)`);
    } catch (e) {
      dropError = e;
    }
    await admin.close();
    await rm(work, { recursive: true, force: true });
  }
  if (dropError !== null)
    throw new Error(`could not drop the drill database "${scratch}": drop it by hand now`, {
      cause: dropError,
    });
  return result;
}

export function renderDrillReport(r: DrillResult): string {
  return [
    `# Simulacro de recuperación — ${r.startedAt.slice(0, 10)}`,
    "",
    "Generado por `pnpm dr:drill --report` (docs/runbooks/disaster-recovery.md). Copia cifrada → restauración en una base nueva del mismo servidor → verificación de recuentos.",
    "",
    "| Medida | Valor |",
    "|---|---|",
    `| Tablas | ${String(r.tables)} |`,
    `| Filas | ${String(r.rows)} |`,
    `| Tamaño del volcado | ${String(r.bytes)} bytes |`,
    `| Copia (pg_dump + cifrado) | ${String(r.backupMs)} ms |`,
    `| Restauración (descifrado verificado + pg_restore + recuentos) | ${String(r.restoreMs)} ms |`,
    `| Total | ${String(r.totalMs)} ms |`,
    `| Recuentos verificados | ${r.verified ? "sí" : `no (${String(r.mismatches.length)} tablas difieren)`} |`,
    "",
    "El RTO real añade el aprovisionamiento de la base y el redespliegue (ver el runbook); este simulacro mide la parte de datos.",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  if (!config.env.DATABASE_ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required for the drill.");
  const now = new Date();
  const kms = createIntegrations(config, { now: () => now }).kms;
  const result = await runDrill({ adminUrl: config.env.DATABASE_ADMIN_URL, keys: kms.backupKeys, now });
  const report = renderDrillReport(result);
  process.stdout.write(report);
  if (process.argv.includes("--report"))
    await writeFile(`docs/runbooks/dr-drill-${now.toISOString().slice(0, 10)}.md`, report);
  if (!result.verified) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("dr-drill.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
