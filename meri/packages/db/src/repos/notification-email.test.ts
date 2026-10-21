import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../client";
import { TEST_ADMIN_URL, TEST_APP_URL } from "../test/urls";
import { withWorkspace } from "../workspace";
import { bootstrapAccount } from "./accounts";
import {
  getNotificationForEmail,
  markNotificationEmail,
  workspaceEmailRecipient,
} from "./notification-email";
import { insertNotification } from "./notifications";

const NOW = new Date("2026-10-20T08:40:00Z");
const uniq = (p: string) => `${p}-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}@test.local`;

describe("notification email repos (D-115)", () => {
  const app = createDb(TEST_APP_URL, { max: 1 });
  const owner = createDb(TEST_ADMIN_URL, { max: 1 });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });
  const inWs = (ws: string, fn: (tx: typeof owner.sql) => Promise<unknown>) =>
    owner.sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${ws}, true)`;
      await fn(tx as unknown as typeof owner.sql);
    });

  it("records the outcome once; only `sent` gets a timestamp; another workspace sees nothing", async () => {
    const a = await bootstrapAccount(app.db, { email: uniq("ne-a"), now: NOW });
    const b = await bootstrapAccount(app.db, { email: uniq("ne-b"), now: NOW });
    const ws = a.workspaceId;
    const note = () =>
      withWorkspace(app.db, ws, (tx) =>
        insertNotification(
          tx,
          ws,
          {
            kind: "digest",
            template: "daily.digest",
            title: "t",
            body: "b",
            params: {},
            refs: [],
            day: "2026-10-20",
          },
          NOW,
        ),
      );
    const sent = await note();
    expect(await withWorkspace(app.db, ws, (tx) => markNotificationEmail(tx, ws, sent.id, "sent", NOW))).toBe(
      true,
    );
    // A duplicate run that then hits a permanent error never overwrites `sent`.
    expect(
      await withWorkspace(app.db, ws, (tx) => markNotificationEmail(tx, ws, sent.id, "failed", NOW)),
    ).toBe(false);
    const read = await withWorkspace(app.db, ws, (tx) => getNotificationForEmail(tx, ws, sent.id));
    expect(read?.emailState).toBe("sent");
    for (const state of ["skipped", "failed"] as const) {
      const n = await note();
      await withWorkspace(app.db, ws, (tx) => markNotificationEmail(tx, ws, n.id, state, NOW));
      const [row] = await owner.sql.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${ws}, true)`;
        return tx<{ email_state: string; emailed_at: Date | null }[]>`
          select email_state, emailed_at from notifications where id = ${n.id}`;
      });
      expect(row).toEqual({ email_state: state, emailed_at: null });
    }
    // RLS, not only the WHERE clause: B's context cannot read or mark A's row.
    const other = b.workspaceId;
    expect(
      await withWorkspace(app.db, other, (tx) => getNotificationForEmail(tx, other, sent.id)),
    ).toBeNull();
    const fresh = await note();
    expect(
      await withWorkspace(app.db, other, (tx) => markNotificationEmail(tx, other, fresh.id, "sent", NOW)),
    ).toBe(false);
  });

  it("the recipient is the live owner: never a member, a deleted workspace or a deleted user", async () => {
    const a = await bootstrapAccount(app.db, { email: uniq("rc-owner"), locale: "en", now: NOW });
    const member = await bootstrapAccount(app.db, { email: uniq("rc-member"), now: NOW });
    await inWs(
      a.workspaceId,
      (tx) =>
        tx`insert into memberships (workspace_id, user_id, role) values (${a.workspaceId}, ${member.userId}, 'member')`,
    );
    expect(
      await withWorkspace(app.db, a.workspaceId, (tx) => workspaceEmailRecipient(tx, a.workspaceId)),
    ).toEqual({
      userId: a.userId,
      email: a.email,
      locale: "en",
    });
    await inWs(
      a.workspaceId,
      (tx) =>
        tx`update workspaces set deleted_at = ${NOW.toISOString()}::timestamptz where id = ${a.workspaceId}`,
    );
    expect(
      await withWorkspace(app.db, a.workspaceId, (tx) => workspaceEmailRecipient(tx, a.workspaceId)),
    ).toBeNull();
  });
});
