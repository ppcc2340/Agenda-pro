import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { DbFlagStore, setFlag } from "./flags";
import { newId } from "./ids";
import { bootstrapAccount } from "./repos/accounts";
import { assignPriceCohort, getSubscription } from "./repos/billing";
import { TEST_ADMIN_URL, TEST_APP_URL } from "./test/urls";
import { withWorkspace } from "./workspace";

const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
};

describe("feature flags in the database and the price cohort (D-102)", () => {
  const app = createDb(TEST_APP_URL, { max: 1 });
  const owner = createDb(TEST_ADMIN_URL, { max: 1 });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("a workspace row overrides the global one; the app role reads but cannot write; reads are cached", async () => {
    const ws = newId();
    let clock = 0;
    const store = new DbFlagStore(app.db, 1_000, () => clock);
    await setFlag(owner.db, { flag: "time_inference", enabled: true });
    expect(await store.isEnabled("time_inference")).toBe(true);
    await setFlag(owner.db, { flag: "time_inference", enabled: false, workspaceId: ws });
    expect(await store.isEnabled("time_inference", ws)).toBe(false);
    // Cached until the TTL passes.
    await setFlag(owner.db, { flag: "time_inference", enabled: false });
    expect(await store.isEnabled("time_inference")).toBe(true);
    clock = 2_000;
    expect(await store.isEnabled("time_inference")).toBe(false);
    await expect(setFlag(owner.db, { flag: "nope", enabled: true })).rejects.toThrow(/unknown flag/);
    await expect(
      app.db.execute(sql`insert into feature_flags (id, key, enabled) values (${newId()}, 'x', true)`),
    ).rejects.toSatisfy((e) => /permission denied/.test(pgMessage(e)));
  });

  it("the cohort is stored once and never changes", async () => {
    const acc = await bootstrapAccount(app.db, { email: `cohort-${newId()}@test.local`, now: new Date() });
    await withWorkspace(app.db, acc.workspaceId, async (tx) => {
      expect((await getSubscription(tx, acc.workspaceId))?.priceCohort).toBeNull();
      expect(await assignPriceCohort(tx, acc.workspaceId, "B")).toBe("B");
      expect(await assignPriceCohort(tx, acc.workspaceId, "A")).toBe("B");
      expect((await getSubscription(tx, acc.workspaceId))?.priceCohort).toBe("B");
    });
  });
});
