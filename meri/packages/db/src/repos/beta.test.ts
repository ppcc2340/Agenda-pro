import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../client";
import { newId } from "../ids";
import { purgeWorkspace, remainingPersonalRows } from "../purge";
import { TEST_ADMIN_URL, TEST_APP_URL } from "../test/urls";
import { ADMIN_WORKSPACE_CONTEXT, withWorkspace } from "../workspace";
import { BetaInviteRequiredError, bootstrapAccount, softDeleteAccount } from "./accounts";
import {
  countFeedbackSince,
  insertFeedback,
  joinWaitlist,
  listSurveyHistory,
  pruneWaitlist,
  recordSurvey,
} from "./beta";

const now = new Date("2026-10-21T09:00:00Z");
const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
};

/** Closed beta (D-099, SEC-H3): invitations, waitlist and the tenant tables of phase 6. */
describe("beta tables", () => {
  let app: DbHandle;
  let owner: DbHandle;
  beforeAll(() => {
    app = createDb(TEST_APP_URL, { max: 2 });
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });
  const email = (p: string) => `${p}-${newId()}@test.local`;
  const count = async (table: "beta_invites" | "waitlist", address: string): Promise<number> => {
    const rows = await owner.db.execute<{ n: number | string }>(
      sql`select count(*)::int as n from ${sql.identifier(table)} where email = ${address}`,
    );
    return Number(rows[0]?.n ?? 0);
  };

  it("an invite-only beta refuses a new address without invitation and creates nothing", async () => {
    const address = email("noinvite");
    await expect(
      bootstrapAccount(app.db, { email: address, now, requireInvite: true }),
    ).rejects.toBeInstanceOf(BetaInviteRequiredError);
    const users = await owner.db.execute(sql`select 1 from users where email = ${address}`);
    expect(users.length).toBe(0);
  });

  it("an invitation is consumed with the account, together with the waitlist entry", async () => {
    const address = email("invited");
    await joinWaitlist(app.db, { email: address.toUpperCase(), locale: "es", now });
    await owner.db.execute(sql`insert into beta_invites (email) values (${address})`);
    const acc = await bootstrapAccount(app.db, { email: address, now, requireInvite: true });
    expect(acc.created).toBe(true);
    expect(await count("beta_invites", address)).toBe(0);
    expect(await count("waitlist", address)).toBe(0);
    // Signing in again needs no invitation.
    expect((await bootstrapAccount(app.db, { email: address, now, requireInvite: true })).created).toBe(
      false,
    );
  });

  it("the application role can join the waitlist (idempotently) but never read it nor the invitations", async () => {
    const address = email("wl");
    await joinWaitlist(app.db, { email: address, locale: "en", now });
    await joinWaitlist(app.db, { email: address, locale: "en", now });
    expect(await count("waitlist", address)).toBe(1);
    for (const table of ["waitlist", "beta_invites"])
      await expect(app.db.execute(sql`select * from ${sql.identifier(table)}`)).rejects.toSatisfy((e) =>
        /permission denied/.test(pgMessage(e)),
      );
    await expect(app.db.execute(sql`delete from waitlist`)).rejects.toSatisfy((e) =>
      /permission denied/.test(pgMessage(e)),
    );
    await expect(
      app.db.execute(sql`insert into beta_invites (email) values ('self@test.local')`),
    ).rejects.toSatisfy((e) => /permission denied/.test(pgMessage(e)));
  });

  it("the waitlist keeps entries 180 days", async () => {
    const old = email("old");
    await owner.db.execute(
      sql`insert into waitlist (email, consent_at, created_at) values (${old}, now(), now() - interval '181 days')`,
    );
    expect(await pruneWaitlist(app.db)).toBeGreaterThanOrEqual(1);
    expect(await count("waitlist", old)).toBe(0);
  });

  it("purging a workspace removes beta rows naming its members", async () => {
    const address = email("purge-beta");
    const acc = await bootstrapAccount(app.db, { email: address, now });
    // A leftover entry with the same address (re-joined the waitlist after signing up).
    await joinWaitlist(app.db, { email: address, locale: "es", now });
    await softDeleteAccount(app.db, { userId: acc.userId, workspaceId: acc.workspaceId, now });
    await owner.db.execute(
      sql`update workspaces set deleted_at = now() - interval '31 days' where id = ${acc.workspaceId}`,
    );
    await purgeWorkspace(app.db, acc.workspaceId);
    const left = await remainingPersonalRows(owner.db, {
      workspaceId: acc.workspaceId,
      userIds: [acc.userId],
      emails: [address],
    });
    expect(Object.entries(left).filter(([, n]) => n > 0)).toEqual([]);
  });

  it("feedback and survey answers stay inside their workspace", async () => {
    const a = await bootstrapAccount(app.db, { email: email("fb-a"), now });
    const b = await bootstrapAccount(app.db, { email: email("fb-b"), now });
    await withWorkspace(app.db, a.workspaceId, async (tx) => {
      await insertFeedback(tx, a.workspaceId, { kind: "idea", message: "Más atajos", pagePath: "/hoy", now });
      await recordSurvey(tx, a.workspaceId, { answer: "very", comment: null, now });
    });
    await withWorkspace(app.db, b.workspaceId, async (tx) => {
      expect(await countFeedbackSince(tx, b.workspaceId, new Date(0))).toBe(0);
      expect(await listSurveyHistory(tx, b.workspaceId)).toEqual([]);
    });
    // Writing into another workspace is refused by RLS (a failed statement aborts the whole transaction).
    await expect(
      withWorkspace(app.db, b.workspaceId, (tx) =>
        insertFeedback(tx, a.workspaceId, { kind: "bug", message: "x", pagePath: null, now }),
      ),
    ).rejects.toSatisfy((e) => /row-level security/.test(pgMessage(e)));
    await withWorkspace(app.db, a.workspaceId, async (tx) => {
      expect(await countFeedbackSince(tx, a.workspaceId, new Date(0))).toBe(1);
      expect((await listSurveyHistory(tx, a.workspaceId))[0]).toMatchObject({
        answer: "very",
        dismissedAt: null,
      });
    });
  });
});
