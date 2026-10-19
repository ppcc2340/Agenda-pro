import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../client";
import { newId } from "../ids";
import { bootstrapAccount, getMe } from "./accounts";
import { getPreferences, updatePreferences } from "./preferences";
import { listAudit, audit } from "./audit";
import { TEST_APP_URL } from "../test/urls";
import { withWorkspace } from "../workspace";

describe("account bootstrap and preferences (F-01)", () => {
  let handle: DbHandle;
  const now = new Date("2026-10-19T10:40:00Z");
  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 2 });
  });
  afterAll(async () => {
    await handle.close();
  });

  it("creates user, workspace, membership, preferences, trial and entitlements once, then is idempotent", async () => {
    const email = `  Person-${newId()}@Test.local `;
    const first = await bootstrapAccount(handle.db, { email, name: "Person", now });
    expect(first.created).toBe(true);
    expect(first.email).toBe(email.trim().toLowerCase());
    const second = await bootstrapAccount(handle.db, { email, name: "Person Renamed", now });
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.workspaceId).toBe(first.workspaceId);

    const me = await getMe(handle.db, first.userId, first.workspaceId);
    expect(me?.user.name).toBe("Person Renamed");
    expect(me?.plan).toMatchObject({ plan: "trial", status: "trialing" });
    expect(me?.plan.trialEndsAt?.toISOString()).toBe("2026-11-02T10:40:00.000Z");
    expect(me?.entitlements.aiCreditsMonthly).toBe(300);
    expect(me?.onboarded).toBe(false);
  });

  it("getMe refuses a user that is not a member of the workspace", async () => {
    const a = await bootstrapAccount(handle.db, { email: `a-${newId()}@test.local`, now });
    const b = await bootstrapAccount(handle.db, { email: `b-${newId()}@test.local`, now });
    expect(await getMe(handle.db, a.userId, b.workspaceId)).toBeNull();
  });

  it("updates preferences, completes onboarding and pages the audit log by cursor", async () => {
    const acc = await bootstrapAccount(handle.db, { email: `p-${newId()}@test.local`, now });
    const prefs = await withWorkspace(handle.db, acc.workspaceId, async (tx) => {
      const updated = await updatePreferences(
        tx,
        acc.workspaceId,
        { timezone: "America/Santiago", workStart: "09:00", workEnd: "18:00", contingencyPct: 25 },
        { now, completeOnboarding: true },
      );
      for (let i = 0; i < 3; i++) {
        await audit(
          tx,
          { workspaceId: acc.workspaceId, actor: "user", actorUserId: acc.userId },
          { action: `pref.update.${String(i)}` },
        );
      }
      return updated;
    });
    expect(prefs.timezone).toBe("America/Santiago");
    expect(prefs.contingencyPct).toBe(25);
    expect(prefs.onboardedAt?.toISOString()).toBe(now.toISOString());
    expect((await getMe(handle.db, acc.userId, acc.workspaceId))?.onboarded).toBe(true);

    const again = await withWorkspace(handle.db, acc.workspaceId, (tx) =>
      updatePreferences(
        tx,
        acc.workspaceId,
        { bufferMinutes: 5 },
        { now: new Date(now.getTime() + 1000), completeOnboarding: true },
      ),
    );
    expect(again.onboardedAt?.toISOString()).toBe(now.toISOString());
    expect(
      await withWorkspace(handle.db, acc.workspaceId, (tx) => getPreferences(tx, acc.workspaceId)),
    ).toMatchObject({
      bufferMinutes: 5,
    });

    const page1 = await withWorkspace(handle.db, acc.workspaceId, (tx) => listAudit(tx, acc.workspaceId, 2));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const cursor = page1.nextCursor ?? "";
    const page2 = await withWorkspace(handle.db, acc.workspaceId, (tx) =>
      listAudit(tx, acc.workspaceId, 2, cursor),
    );
    expect(page2.items.map((i) => i.action)).toEqual(expect.arrayContaining(["pref.update.0"]));
    expect(page2.nextCursor).toBeNull();
    const all = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(all).size).toBe(3);
  });
});

describe("bootstrap race safety (ADR 0001)", () => {
  it("two concurrent first logins for the same email yield one account", async () => {
    const handle = createDb(TEST_APP_URL, { max: 4 });
    try {
      const email = `race-${newId()}@test.local`;
      const now = new Date("2026-10-19T10:40:00Z");
      const results = await Promise.all(
        [1, 2, 3].map(() => bootstrapAccount(handle.db, { email, name: "Race", now })),
      );
      const ids = new Set(results.map((r) => r.userId));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
