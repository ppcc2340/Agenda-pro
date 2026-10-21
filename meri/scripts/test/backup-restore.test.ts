import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyRing, LocalKeyProvider, localKeyId } from "@meri/config/crypto";
import {
  ADMIN_WORKSPACE_CONTEXT,
  audit,
  bootstrapAccount,
  createDb,
  purgeWorkspace,
  softDeleteAccount,
  withWorkspace,
} from "@meri/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDrillReport, runDrill } from "../dr-drill";
import { createBackup, restoreBackup } from "../lib/backup";

// The admin OWNER role (not a superuser locally): backups must work under FORCE RLS (plan review CR-H2).
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const k = Buffer.alloc(32, 81).toString("base64");
const keys = new KeyRing(new LocalKeyProvider(k, localKeyId(k)));
const NOW = new Date("2026-10-20T08:40:00Z");

const dbUrl = (name: string) => {
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return u.toString();
};

describe("encrypted backup and restore (ADR 0007, P5-03/P5-10)", () => {
  let work: string;
  const target = `meri_restore_${Date.now().toString(36)}`;
  const admin = createDb(ADMIN, { max: 1 });
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "meri-bk-test-"));
    await admin.sql.unsafe(`create database "${target}"`);
  });
  afterAll(async () => {
    await admin.sql.unsafe(`drop database if exists "${target}" with (force)`);
    await admin.close();
    await rm(work, { recursive: true, force: true });
  });

  it("backs up every tenant row under FORCE RLS and restores an identical database", async () => {
    const backup = await createBackup({ adminUrl: ADMIN, keys, out: join(work, "t.mbk"), now: NOW });
    expect(backup.manifest.migrations).toBeGreaterThanOrEqual(18);
    expect(backup.manifest.tables.audit_log ?? 0).toBeGreaterThan(0);
    expect(backup.keyId).toBe(keys.keyId);
    const restored = await restoreBackup({ file: backup.path, targetUrl: dbUrl(target), keys });
    expect(restored.mismatches).toEqual([]);
    // RLS survives the restore: policies are part of the dump.
    const check = createDb(dbUrl(target), { max: 1 });
    try {
      const [row] = await check.sql<
        { n: string }[]
      >`select count(*)::text as n from pg_policies where policyname = 'ws_isolation'`;
      expect(Number(row?.n ?? 0)).toBeGreaterThan(20);
    } finally {
      await check.close();
    }
    // A second restore into the now non-empty database is refused before anything is touched.
    await expect(restoreBackup({ file: backup.path, targetUrl: dbUrl(target), keys })).rejects.toThrow(
      /not empty/,
    );
  });

  it("restores the exact rows of known tenants, not only matching counts (counts and dump share the RLS context)", async () => {
    const app = createDb(APP, { max: 1 });
    const third = `meri_restore_ids_${Date.now().toString(36)}`;
    try {
      const tenants = [
        await bootstrapAccount(app.db, { email: `bk-a-${Date.now().toString(36)}@test.local`, now: NOW }),
        await bootstrapAccount(app.db, { email: `bk-b-${Date.now().toString(36)}@test.local`, now: NOW }),
      ];
      // Tenant rows protected by FORCE RLS (bootstrap writes no audit entry itself).
      for (const tenant of tenants)
        await withWorkspace(app.db, tenant.workspaceId, (tx) =>
          audit(
            tx,
            { workspaceId: tenant.workspaceId, actor: "user", actorUserId: tenant.userId },
            { action: "task.created", entityType: "task", entityId: tenant.userId },
          ),
        );
      const backup = await createBackup({ adminUrl: ADMIN, keys, out: join(work, "ids.mbk"), now: NOW });
      await admin.sql.unsafe(`create database "${third}"`);
      await restoreBackup({ file: backup.path, targetUrl: dbUrl(third), keys });
      // Read the restored copy under the admin read context: FORCE RLS still applies to the owner.
      const check = createDb(dbUrl(third), {
        max: 1,
        connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
      });
      try {
        for (const tenant of tenants)
          for (const table of ["workspaces", "memberships", "preferences", "audit_log"] as const) {
            const column = table === "workspaces" ? "id" : "workspace_id";
            const rows =
              await check.sql`select 1 from ${check.sql(table)} where ${check.sql(column)} = ${tenant.workspaceId}`;
            expect(rows.length, `${table} of ${tenant.workspaceId}`).toBeGreaterThan(0);
          }
      } finally {
        await check.close();
      }
    } finally {
      await app.close();
      await admin.sql.unsafe(`drop database if exists "${third}" with (force)`);
    }
  });

  it("a corrupted file is refused before pg_restore writes anything into the target", async () => {
    const empty = `meri_restore_bad_${Date.now().toString(36)}`;
    try {
      const backup = await createBackup({ adminUrl: ADMIN, keys, out: join(work, "bad.mbk"), now: NOW });
      const bytes = await readFile(backup.path);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      await writeFile(backup.path, bytes);
      await admin.sql.unsafe(`create database "${empty}"`);
      await expect(restoreBackup({ file: backup.path, targetUrl: dbUrl(empty), keys })).rejects.toThrow();
      const check = createDb(dbUrl(empty), { max: 1 });
      try {
        const [row] = await check.sql<
          { n: string }[]
        >`select count(*)::text as n from pg_tables where schemaname = 'public'`;
        expect(Number(row?.n ?? -1)).toBe(0);
      } finally {
        await check.close();
      }
    } finally {
      await admin.sql.unsafe(`drop database if exists "${empty}" with (force)`);
    }
  });

  it("the drill measures backup and restore into a scratch database and cleans it up", async () => {
    const result = await runDrill({ adminUrl: ADMIN, keys, now: NOW });
    expect(result.verified).toBe(true);
    expect(result.rows).toBeGreaterThan(0);
    expect(renderDrillReport(result)).toContain("| Recuentos verificados | sí |");
    const [left] = await admin.sql<
      { n: string }[]
    >`select count(*)::text as n from pg_database where datname like 'meri_drill_%'`;
    expect(Number(left?.n ?? 1)).toBe(0);
  });

  it("a restore re-applies erasures that happened after the backup (receipts from the primary)", async () => {
    const app = createDb(APP, { max: 1 });
    const second = `meri_restore_rx_${Date.now().toString(36)}`;
    try {
      const gone = await bootstrapAccount(app.db, {
        email: `gone-${Date.now().toString(36)}@test.local`,
        now: NOW,
      });
      const backup = await createBackup({ adminUrl: ADMIN, keys, out: join(work, "rx.mbk"), now: NOW });
      // After the backup: the account is deleted and purged on the primary.
      await softDeleteAccount(app.db, { userId: gone.userId, workspaceId: gone.workspaceId, now: NOW });
      await admin.sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${gone.workspaceId}`;
      await purgeWorkspace(app.db, gone.workspaceId);
      await admin.sql.unsafe(`create database "${second}"`);
      const restored = await restoreBackup({
        file: backup.path,
        targetUrl: dbUrl(second),
        keys,
        receiptsFromUrl: ADMIN,
      });
      expect(restored.mismatches).toEqual([]);
      expect(restored.reapplied).toBeGreaterThanOrEqual(1);
      const check = createDb(dbUrl(second), { max: 1 });
      try {
        const ws = await check.sql`select 1 from workspaces where id = ${gone.workspaceId}`;
        const user = await check.sql`select 1 from users where id = ${gone.userId}`;
        expect([ws.length, user.length]).toEqual([0, 0]);
      } finally {
        await check.close();
      }
    } finally {
      await app.close();
      await admin.sql.unsafe(`drop database if exists "${second}" with (force)`);
    }
  });
});
