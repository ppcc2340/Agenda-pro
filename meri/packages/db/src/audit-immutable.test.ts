import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { newId } from "./ids";
import { bootstrapAccount } from "./repos/accounts";
import { audit } from "./repos/audit";
import { TEST_ADMIN_URL, TEST_APP_URL } from "./test/urls";
import { ADMIN_WORKSPACE_CONTEXT, withWorkspace } from "./workspace";

const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
};

/** ADR 0007 (migration 0019): the audit trail cannot be edited or deleted by any role, owner included. */
describe("audit_log immutability", () => {
  let app: DbHandle;
  let owner: DbHandle;
  beforeAll(() => {
    app = createDb(TEST_APP_URL, { max: 1 });
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("refuses UPDATE and direct DELETE even for the table owner, and no session flag opens it", async () => {
    const now = new Date("2026-10-20T08:40:00Z");
    const a = await bootstrapAccount(app.db, { email: `imm-${newId()}@test.local`, now });
    const id = await withWorkspace(app.db, a.workspaceId, (tx) =>
      audit(
        tx,
        { workspaceId: a.workspaceId, actor: "user", actorUserId: a.userId },
        { action: "task.created", entityType: "task", entityId: newId() },
      ),
    );
    // The application role has no UPDATE/DELETE privilege at all.
    await expect(app.db.execute(sql`update audit_log set action = 'forged' where id = ${id}`)).rejects.toSatisfy((e) =>
      /permission denied/.test(pgMessage(e)),
    );
    await expect(app.db.execute(sql`delete from audit_log where id = ${id}`)).rejects.toSatisfy((e) =>
      /permission denied/.test(pgMessage(e)),
    );
    // The owner, inside the row's own workspace context (so RLS shows the row), is stopped by the trigger.
    const asOwner = (statement: SQL, flag = false) =>
      owner.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${a.workspaceId}, true)`);
        if (flag) await tx.execute(sql`select set_config('app.purge', 'on', true)`);
        await tx.execute(statement);
      });
    await expect(asOwner(sql`update audit_log set action = 'forged' where id = ${id}`)).rejects.toSatisfy((e) =>
      /append-only/.test(pgMessage(e)),
    );
    await expect(asOwner(sql`delete from audit_log where id = ${id}`)).rejects.toSatisfy((e) =>
      /only removed with their workspace/.test(pgMessage(e)),
    );
    await expect(asOwner(sql`delete from audit_log where id = ${id}`, true)).rejects.toSatisfy((e) =>
      /only removed with their workspace/.test(pgMessage(e)),
    );
    // Read back under the admin read context: untouched.
    const still = await owner.db.execute(sql`select action from audit_log where id = ${id}`);
    expect(still[0]).toMatchObject({ action: "task.created" });
  });
});
