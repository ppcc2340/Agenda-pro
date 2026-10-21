import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "@meri/config/crypto";
import { ADMIN_WORKSPACE_CONTEXT, createDb, deletionSubjectHash } from "@meri/db";
import { decryptBackupFile, encryptBackupFile, type BackupManifest } from "./backup-format";

/**
 * Logical backups (ADR 0007, docs/runbooks/backup-restore.md). The dump runs as the admin owner with the admin read
 * context (`app.workspace_id = '*'`, D-037) and `--enable-row-security`, so FORCE RLS is honoured and every tenant
 * row is included without a BYPASSRLS role. pg tools get the connection URL without its password, which travels in
 * `PGPASSWORD` (process arguments are visible to every local user through `ps`); nothing is logged.
 */
const ADMIN_READ = "-c app.workspace_id=*";

/** Splits a postgres URL for pg tools: the password goes to the child's environment, never to its arguments. */
export function pgToolConnection(url: string): { dbname: string; env: Record<string, string> } {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return { dbname: parsed.toString(), env: password ? { PGPASSWORD: password } : {} };
}

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
      // stderr from pg tools never contains the password (it is only in PGPASSWORD).
      if (code === 0) resolve();
      else
        reject(
          new Error(`${cmd} exited with ${String(code)}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`),
        );
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
export async function tableCounts(
  url: string,
): Promise<{ migrations: number; tables: Record<string, number> }> {
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
    const handle = createDb(options.adminUrl, {
      max: 1,
      connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
    });
    let counts: Awaited<ReturnType<typeof countTables>>;
    try {
      counts = await handle.sql.begin("isolation level repeatable read read only", async (tx) => {
        const [snap] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
        // TransactionSql has the same tagged-template and identifier API that countTables uses.
        const inSnapshot = await countTables(tx as unknown as Sql);
        const conn = pgToolConnection(options.adminUrl);
        await run(
          "pg_dump",
          [
            "--format=custom",
            "--enable-row-security",
            `--snapshot=${snap?.id ?? ""}`,
            `--dbname=${conn.dbname}`,
            `--file=${dump}`,
          ],
          { PGOPTIONS: ADMIN_READ, ...conn.env },
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
    return {
      path: options.out,
      manifest,
      dumpMs,
      encryptMs: Date.now() - t1,
      bytes: sealed.bytes,
      keyId: sealed.keyId,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Re-applies erasures (F-16): any restored workspace whose hashed id appears in a receipt (from the restored data and,
 * when given, from the surviving primary or a newer backup) is deleted again with its users. Runs as the owner on
 * the freshly restored database; the audit trigger lets the cascade through.
 */
export async function reapplyDeletions(targetUrl: string, receiptsFromUrl?: string): Promise<number> {
  const target = createDb(targetUrl, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  const sources = [target, ...(receiptsFromUrl ? [createDb(receiptsFromUrl, { max: 1 })] : [])];
  try {
    const receipts = new Set<string>();
    for (const source of sources)
      for (const r of await source.sql<{ h: string }[]>`select subject_hash as h from deletion_receipts`)
        receipts.add(r.h);
    const restored = await target.sql<{ id: string }[]>`select id from workspaces`;
    let reapplied = 0;
    for (const { id } of restored) {
      if (!receipts.has(deletionSubjectHash(id))) continue;
      await target.sql.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${id}, true)`;
        const members = await tx<
          { userId: string }[]
        >`select user_id as "userId" from memberships where workspace_id = ${id}`;
        await tx`delete from feature_flags where workspace_id = ${id}`;
        await tx`delete from workspaces where id = ${id}`;
        await tx`select set_config('app.workspace_id', '*', true)`;
        for (const { userId } of members)
          await tx`delete from users u where u.id = ${userId}
            and not exists (select 1 from memberships m where m.user_id = u.id)
            and not exists (select 1 from workspaces w where w.owner_id = u.id)`;
      });
      reapplied++;
    }
    return reapplied;
  } finally {
    for (const source of sources) await source.close();
  }
}

export interface RestoreResult {
  /** Workspaces erased again because a receipt says they were purged. */
  reapplied: number;
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
    if (Number(row?.n ?? 0) > 0)
      throw new Error("restore target is not empty: refusing to overwrite a database");
  } finally {
    await handle.close();
  }
}

export async function restoreBackup(options: {
  file: string;
  targetUrl: string;
  keys: KeyProvider;
  /** Database whose erasure receipts are authoritative (the surviving primary or a newer restore). */
  receiptsFromUrl?: string;
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
    const conn = pgToolConnection(options.targetUrl);
    await run("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${conn.dbname}`, dump], conn.env);
    const restoreMs = Date.now() - t1;
    // Counts are verified against the manifest before any erasure is re-applied (which legitimately removes rows).
    const restored = await tableCounts(options.targetUrl);
    const mismatches = Object.entries(manifest.tables)
      .map(([table, expected]) => ({ table, expected, actual: restored.tables[table] ?? -1 }))
      .filter((m) => m.expected !== m.actual);
    const reapplied = await reapplyDeletions(options.targetUrl, options.receiptsFromUrl);
    return { manifest, decryptMs, restoreMs, mismatches, reapplied };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
