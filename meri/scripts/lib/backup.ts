import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "@meri/config/crypto";
import { ADMIN_WORKSPACE_CONTEXT, createDb } from "@meri/db";
import { decryptBackupFile, encryptBackupFile, type BackupManifest } from "./backup-format";

/**
 * Logical backups (ADR 0007, docs/runbooks/backup-restore.md). The dump runs as the admin owner with the admin read
 * context (`app.workspace_id = '*'`, D-037) and `--enable-row-security`, so FORCE RLS is honoured and every tenant
 * row is included without a BYPASSRLS role. Connection strings are passed to pg tools as arguments, never logged.
 */
const ADMIN_READ = "-c app.workspace_id=*";

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`${cmd} could not start (${err.message}); install postgresql-client-16`));
    });
    child.on("close", (code) => {
      // stderr from pg tools never contains the password (passed in the URL argument, not echoed).
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${String(code)}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

type Sql = ReturnType<typeof createDb>["sql"];

async function countTables(sql: Sql): Promise<{ migrations: number; tables: Record<string, number> }> {
  const tables = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' order by tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(tablename)}`;
    counts[tablename] = Number(row?.n ?? 0);
  }
  const [mig] = await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`;
  return { migrations: Number(mig?.n ?? 0), tables: counts };
}

/** Row count per public table plus the number of applied migrations, read under the admin read context. */
export async function tableCounts(url: string): Promise<{ migrations: number; tables: Record<string, number> }> {
  const handle = createDb(url, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  try {
    return await countTables(handle.sql);
  } finally {
    await handle.close();
  }
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
  dumpMs: number;
  encryptMs: number;
  bytes: number;
  keyId: string;
}

export async function createBackup(options: {
  adminUrl: string;
  keys: KeyProvider;
  out: string;
  now: Date;
}): Promise<BackupResult> {
  const work = await mkdtemp(join(tmpdir(), "meri-backup-"));
  try {
    const dump = join(work, "db.dump");
    const t0 = Date.now();
    // The manifest and the dump read the same exported snapshot: concurrent writes can never make the
    // verification of a restore disagree with what was actually dumped.
    const handle = createDb(options.adminUrl, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
    let counts: Awaited<ReturnType<typeof countTables>>;
    try {
      counts = await handle.sql.begin("isolation level repeatable read read only", async (tx) => {
        const [snap] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
        // TransactionSql has the same tagged-template and identifier API that countTables uses.
        const inSnapshot = await countTables(tx as unknown as Sql);
        await run(
          "pg_dump",
          [
            "--format=custom",
            "--enable-row-security",
            `--snapshot=${snap?.id ?? ""}`,
            `--dbname=${options.adminUrl}`,
            `--file=${dump}`,
          ],
          { PGOPTIONS: ADMIN_READ },
        );
        return inSnapshot;
      });
    } finally {
      await handle.close();
    }
    const dumpMs = Date.now() - t0;
    const manifest: BackupManifest = { createdAt: options.now.toISOString(), ...counts };
    const t1 = Date.now();
    const sealed = await encryptBackupFile(options.keys, dump, options.out, manifest);
    return { path: options.out, manifest, dumpMs, encryptMs: Date.now() - t1, bytes: sealed.bytes, keyId: sealed.keyId };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface RestoreResult {
  manifest: BackupManifest;
  decryptMs: number;
  restoreMs: number;
  /** Tables whose restored row count differs from the manifest (empty = verified). */
  mismatches: { table: string; expected: number; actual: number }[];
}

/** Refuses any target that already has tables: a restore never overwrites a live database. */
export async function assertEmptyTarget(targetUrl: string): Promise<void> {
  const handle = createDb(targetUrl, { max: 1 });
  try {
    const [row] = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from pg_tables where schemaname not in ('pg_catalog', 'information_schema')`;
    if (Number(row?.n ?? 0) > 0) throw new Error("restore target is not empty: refusing to overwrite a database");
  } finally {
    await handle.close();
  }
}

export async function restoreBackup(options: {
  file: string;
  targetUrl: string;
  keys: KeyProvider;
}): Promise<RestoreResult> {
  await assertEmptyTarget(options.targetUrl);
  const work = await mkdtemp(join(tmpdir(), "meri-restore-"));
  try {
    const dump = join(work, "db.dump");
    const t0 = Date.now();
    // The whole file is authenticated before pg_restore sees a single byte.
    const manifest = await decryptBackupFile(options.keys, options.file, dump);
    const decryptMs = Date.now() - t0;
    const t1 = Date.now();
    await run("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${options.targetUrl}`, dump]);
    const restoreMs = Date.now() - t1;
    const restored = await tableCounts(options.targetUrl);
    const mismatches = Object.entries(manifest.tables)
      .map(([table, expected]) => ({ table, expected, actual: restored.tables[table] ?? -1 }))
      .filter((m) => m.expected !== m.actual);
    return { manifest, decryptMs, restoreMs, mismatches };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
