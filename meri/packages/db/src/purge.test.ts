import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { newId } from "./ids";
import { deletionSubjectHash, purgeWorkspace, remainingPersonalRows, TABLE_CLASSIFICATION } from "./purge";
import { bootstrapAccount, softDeleteAccount } from "./repos/accounts";
import { audit } from "./repos/audit";
import { clients } from "./schema";
import { TEST_ADMIN_URL, TEST_APP_URL } from "./test/urls";
import { ADMIN_WORKSPACE_CONTEXT, withWorkspace } from "./workspace";

const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
};
const now = new Date("2026-10-19T10:40:00Z");

/** F-16 AC1 (ADR 0007): after the purge no row of the account remains; the app role can never shortcut it. */
describe("workspace purge and erasure verification", () => {
  let app: DbHandle;
  let admin: DbHandle;
  beforeAll(() => {
    app = createDb(TEST_APP_URL, { max: 2 });
    admin = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await app.close();
    await admin.close();
  });

  it("every table in the schema is classified (a new table must say how it is erased)", async () => {
    const rows = await admin.db.execute(
      sql`select tablename from pg_tables where schemaname = 'public' order by 1`,
    );
    const tables = rows.map((r) => (r as { tablename: string }).tablename);
    expect(tables.sort()).toEqual(Object.keys(TABLE_CLASSIFICATION).sort());
    for (const [table, kind] of Object.entries(TABLE_CLASSIFICATION)) {
      if (kind !== "workspace" || table === "workspaces") continue;
      const cols = await admin.db.execute(
        sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'workspace_id'`,
      );
      expect(cols.length, table).toBe(1);
    }
  });

  it("the application role cannot delete workspaces or users, nor read erasure receipts", async () => {
    const a = await bootstrapAccount(app.db, { email: `nodel-${newId()}@test.local`, now });
    await expect(app.db.execute(sql`delete from workspaces where id = ${a.workspaceId}`)).rejects.toSatisfy(
      (e) => /permission denied/.test(pgMessage(e)),
    );
    await expect(app.db.execute(sql`delete from users where id = ${a.userId}`)).rejects.toSatisfy((e) =>
      /permission denied/.test(pgMessage(e)),
    );
    await expect(app.db.execute(sql`select * from deletion_receipts`)).rejects.toSatisfy((e) =>
      /permission denied/.test(pgMessage(e)),
    );
  });

  it("purges only after the 30-day window, removes every row, leaves a receipt, is idempotent and spares others", async () => {
    const a = await bootstrapAccount(app.db, { email: `purge-${newId()}@test.local`, now });
    const b = await bootstrapAccount(app.db, { email: `keep-${newId()}@test.local`, now });
    await withWorkspace(app.db, a.workspaceId, async (tx) => {
      await tx
        .insert(clients)
        .values({ id: newId(), workspaceId: a.workspaceId, name: "Acme", domains: ["acme.com"] });
      await audit(
        tx,
        { workspaceId: a.workspaceId, actor: "user", actorUserId: a.userId },
        { action: "client.created", entityType: "client", entityId: newId() },
      );
    });
    await softDeleteAccount(app.db, { userId: a.userId, workspaceId: a.workspaceId, now });
    // Not yet: the logical deletion happened now.
    await expect(purgeWorkspace(app.db, a.workspaceId)).rejects.toSatisfy((e) =>
      /not eligible/.test(pgMessage(e)),
    );
    // An active workspace can never be purged either.
    await expect(purgeWorkspace(app.db, b.workspaceId)).rejects.toSatisfy((e) =>
      /not eligible/.test(pgMessage(e)),
    );

    await admin.db.execute(
      sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${a.workspaceId}`,
    );
    const removed = await purgeWorkspace(app.db, a.workspaceId);
    expect(removed).toBeGreaterThan(5);
    const left = await remainingPersonalRows(admin.db, {
      workspaceId: a.workspaceId,
      userIds: [a.userId],
      emails: [a.email],
    });
    expect(Object.entries(left).filter(([, n]) => n > 0)).toEqual([]);
    const receipt = await admin.db.execute(
      sql`select rows_deleted, users_deleted from deletion_receipts where subject_hash = ${deletionSubjectHash(a.workspaceId)}`,
    );
    expect(receipt[0]).toMatchObject({ rows_deleted: removed, users_deleted: 1 });
    expect(JSON.stringify(receipt)).not.toContain(a.workspaceId);
    expect(await purgeWorkspace(app.db, a.workspaceId)).toBe(0);

    const kept = await remainingPersonalRows(admin.db, { workspaceId: b.workspaceId, userIds: [b.userId] });
    expect(kept.workspaces).toBe(1);
    expect(kept.users).toBe(1);
    expect(kept.preferences).toBe(1);
  });
});
