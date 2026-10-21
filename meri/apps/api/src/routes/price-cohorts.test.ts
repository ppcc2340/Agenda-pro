import { InMemoryFlagStore } from "@meri/config";
import { DEFAULT_ANCHOR_B, PLANS, priceCohortOf } from "@meri/core";
import type { AccountIdentity } from "@meri/db";
import type { FakeBilling } from "@meri/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, csrf, type TestApp } from "../test/harness";

interface View {
  priceCohort: "A" | "B";
  prices: { pro: { month: number; year: number } };
}

/** Price experiment (D-102): the server decides the cohort, fixes it once, and charges its price end to end. */
describe("price cohorts", () => {
  let t: TestApp;
  const flags = new InMemoryFlagStore();
  beforeAll(async () => {
    t = await createTestApp({ flags });
  });
  afterAll(() => t.close());

  async function accountIn(cohort: "A" | "B"): Promise<AccountIdentity> {
    for (let i = 0; i < 50; i += 1) {
      const acc = await t.createAccount(`cohort-${cohort}`);
      if (priceCohortOf(acc.workspaceId) === cohort) return acc;
    }
    throw new Error("no workspace in cohort");
  }
  const view = async (cookie: string) =>
    (await t.app.inject({ url: "/v1/billing/subscription", headers: { cookie } })).json<View>();

  it("with the experiment off everyone sees the published prices and nothing is fixed", async () => {
    flags.set("price_experiment", false);
    const acc = await accountIn("B");
    const cookie = await t.cookieFor(acc);
    expect(await view(cookie)).toMatchObject({ priceCohort: "A", prices: { pro: PLANS.pro.priceCents } });
  });

  it("with the experiment on a B workspace sees anchor B, keeps it after the experiment ends, and is charged B", async () => {
    flags.set("price_experiment", true);
    const acc = await accountIn("B");
    const cookie = await t.cookieFor(acc);
    expect(await view(cookie)).toMatchObject({ priceCohort: "B", prices: { pro: DEFAULT_ANCHOR_B.pro } });
    flags.set("price_experiment", false);
    expect((await view(cookie)).priceCohort).toBe("B");
    // The client cannot choose: an extra field is ignored and the checkout carries the stored cohort.
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: { cookie, ...csrf, "idempotency-key": "cohort-1" },
      payload: { plan: "pro", interval: "month", cohort: "A" },
    });
    expect(res.statusCode).toBe(200);
    const sessionId = new URL(res.json<{ url: string }>().url).searchParams.get("session") ?? "";
    const fake = t.integrations.billing as FakeBilling;
    expect(fake.sessions.get(sessionId)?.cohort).toBe("B");
  });

  it("an A workspace stays A while the experiment is on", async () => {
    flags.set("price_experiment", true);
    const acc = await accountIn("A");
    expect((await view(await t.cookieFor(acc))).priceCohort).toBe("A");
  });
});
