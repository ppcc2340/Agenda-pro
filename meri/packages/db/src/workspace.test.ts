import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { newId, type UserId, type WorkspaceId } from "./ids";
import { bootstrapAccount } from "./repos/accounts";
import { audit } from "./repos/audit";
import { auditLog, clients } from "./schema";
import { TEST_APP_URL } from "./test/urls";
import { withWorkspace } from "./workspace";

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
    await withWorkspace(handle.db, wsA, (tx) => tx.insert(clients).values({ id: clientId, workspaceId: wsA, name: "Acme" }));
    const seenByA = await withWorkspace(handle.db, wsA, (tx) => tx.select().from(clients));
    const seenByB = await withWorkspace(handle.db, wsB, (tx) => tx.select().from(clients));
    expect(seenByA.map((c) => c.id)).toContain(clientId);
    expect(seenByB.map((c) => c.id)).not.toContain(clientId);
  });

  it("workspace B cannot write rows into workspace A, even with an explicit workspace_id", async () => {
    await expect(
      withWorkspace(handle.db, wsB, (tx) => tx.insert(clients).values({ id: newId(), workspaceId: wsA, name: "Intruder" })),
    ).rejects.toThrow(/row-level security/);
    const clientId = newId();
    await withWorkspace(handle.db, wsA, (tx) => tx.insert(clients).values({ id: clientId, workspaceId: wsA, name: "Mine" }));
    const updated = await withWorkspace(handle.db, wsB, (tx) =>
      tx.update(clients).set({ name: "Hijacked" }).where(sql`${clients.id} = ${clientId}`).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withWorkspace(handle.db, wsB, (tx) => tx.delete(clients).where(sql`${clients.id} = ${clientId}`).returning());
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
      audit(tx, { workspaceId: wsA, actor: "user", actorUserId: userA }, { action: "test.append", after: { ok: true } }),
    );
    await expect(
      withWorkspace(handle.db, wsA, (tx) => tx.update(auditLog).set({ reason: "x" }).where(sql`${auditLog.id} = ${id}`)),
    ).rejects.toThrow(/permission denied/);
    await expect(withWorkspace(handle.db, wsA, (tx) => tx.delete(auditLog).where(sql`${auditLog.id} = ${id}`))).rejects.toThrow(
      /permission denied/,
    );
  });
});
