import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { newId, type UserId, type WorkspaceId } from "./ids";
import { bootstrapAccount } from "./repos/accounts";
import { audit } from "./repos/audit";
import { auditLog, clients } from "./schema";
import { TEST_ADMIN_URL, TEST_APP_URL } from "./test/urls";
import { ADMIN_WORKSPACE_CONTEXT, withWorkspace } from "./workspace";

/** drizzle wraps driver errors ("Failed query: …") and keeps the Postgres message in `cause`. */
const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
};

describe("row level security isolation (docs/03, docs/06 §3)", () => {
  let handle: DbHandle;
  let wsA: WorkspaceId;
  let wsB: WorkspaceId;
  let userA: UserId;
  const now = new Date("2026-10-19T10:40:00Z");

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const a = await bootstrapAccount(handle.db, { email: `a-${newId()}@test.local`, name: "A", now });
    const b = await bootstrapAccount(handle.db, { email: `b-${newId()}@test.local`, name: "B", now });
    wsA = a.workspaceId;
    wsB = b.workspaceId;
    userA = a.userId;
  });
  afterAll(async () => {
    await handle.close();
  });

  it("connects with a role that cannot bypass RLS", async () => {
    const [row] = await handle.sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("workspace A cannot read rows of workspace B", async () => {
    const clientId = newId();
    await withWorkspace(handle.db, wsA, (tx) =>
      tx.insert(clients).values({ id: clientId, workspaceId: wsA, name: "Acme" }),
    );
    const seenByA = await withWorkspace(handle.db, wsA, (tx) => tx.select().from(clients));
    const seenByB = await withWorkspace(handle.db, wsB, (tx) => tx.select().from(clients));
    expect(seenByA.map((c) => c.id)).toContain(clientId);
    expect(seenByB.map((c) => c.id)).not.toContain(clientId);
  });

  it("workspace B cannot write rows into workspace A, even with an explicit workspace_id", async () => {
    await expect(
      withWorkspace(handle.db, wsB, (tx) =>
        tx.insert(clients).values({ id: newId(), workspaceId: wsA, name: "Intruder" }),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(pgMessage(e)));
    const clientId = newId();
    await withWorkspace(handle.db, wsA, (tx) =>
      tx.insert(clients).values({ id: clientId, workspaceId: wsA, name: "Mine" }),
    );
    const updated = await withWorkspace(handle.db, wsB, (tx) =>
      tx
        .update(clients)
        .set({ name: "Hijacked" })
        .where(sql`${clients.id} = ${clientId}`)
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withWorkspace(handle.db, wsB, (tx) =>
      tx
        .delete(clients)
        .where(sql`${clients.id} = ${clientId}`)
        .returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  it("outside withWorkspace no tenant row is visible", async () => {
    const rows = await handle.db.select().from(clients);
    expect(rows).toHaveLength(0);
  });

  it("the workspace context does not leak between transactions", async () => {
    await withWorkspace(handle.db, wsA, (tx) => tx.select().from(clients));
    const [row] = await handle.sql`select current_setting('app.workspace_id', true) as ws`;
    expect(row?.ws ?? "").toBe("");
  });

  it("rejects a malformed workspace id before touching the database", async () => {
    await expect(withWorkspace(handle.db, "not-a-uuid", (tx) => tx.select().from(clients))).rejects.toThrow();
  });

  it("audit_log is append-only for the application role", async () => {
    const id = await withWorkspace(handle.db, wsA, (tx) =>
      audit(
        tx,
        { workspaceId: wsA, actor: "user", actorUserId: userA },
        { action: "test.append", after: { ok: true } },
      ),
    );
    await expect(
      withWorkspace(handle.db, wsA, (tx) =>
        tx
          .update(auditLog)
          .set({ reason: "x" })
          .where(sql`${auditLog.id} = ${id}`),
      ),
    ).rejects.toSatisfy((e: unknown) => /permission denied/.test(pgMessage(e)));
    await expect(
      withWorkspace(handle.db, wsA, (tx) => tx.delete(auditLog).where(sql`${auditLog.id} = ${id}`)),
    ).rejects.toSatisfy((e: unknown) => /permission denied/.test(pgMessage(e)));
  });
});

describe("admin context for cross-tenant dispatchers (D-037)", () => {
  const now = new Date("2026-10-19T10:40:00Z");

  it("the app role gains nothing from app.workspace_id = '*'; the admin role reads every workspace but cannot write outside one", async () => {
    const app = createDb(TEST_APP_URL, { max: 1 });
    const admin = createDb(TEST_ADMIN_URL, {
      max: 1,
      connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
    });
    try {
      const a = await bootstrapAccount(app.db, { email: `adm-a-${newId()}@test.local`, name: "A", now });
      const b = await bootstrapAccount(app.db, { email: `adm-b-${newId()}@test.local`, name: "B", now });
      await withWorkspace(app.db, a.workspaceId, (tx) =>
        tx.insert(clients).values({ id: newId(), workspaceId: a.workspaceId, name: "Acme" }),
      );
      // App role: the wildcard is ignored by the policy → zero rows.
      const seenByApp = await app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', '*', true)`);
        return tx.select().from(clients);
      });
      expect(seenByApp).toHaveLength(0);
      // Admin role with the connection-level wildcard: both workspaces are visible…
      const [row] = await admin.sql`select current_setting('app.workspace_id', true) as ctx`;
      expect(row?.ctx).toBe("*");
      const seenByAdmin =
        await admin.sql`select workspace_id from preferences where workspace_id in (${a.workspaceId}, ${b.workspaceId})`;
      expect(seenByAdmin).toHaveLength(2);
      // …but writes are still tenant-scoped (WITH CHECK unchanged).
      await expect(
        admin.sql`insert into clients (id, workspace_id, name) values (${newId()}, ${a.workspaceId}, 'Intruder')`,
      ).rejects.toThrow(/row-level security/);
      // …and neither DELETE nor UPDATE reach another tenant's rows (the wildcard policy is SELECT-only).
      const deleted = await admin.sql`delete from clients where workspace_id = ${a.workspaceId} returning id`;
      expect(deleted).toHaveLength(0);
      const updated =
        await admin.sql`update clients set name = 'Renamed' where workspace_id = ${a.workspaceId} returning id`;
      expect(updated).toHaveLength(0);
      expect(await admin.sql`select id from clients where workspace_id = ${a.workspaceId}`).toHaveLength(1);
    } finally {
      await app.close();
      await admin.close();
    }
  });
});
