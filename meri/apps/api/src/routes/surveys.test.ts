import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ADMIN_WORKSPACE_CONTEXT, type DbHandle } from "@meri/db";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const DAY = 86_400_000;

/** Sean Ellis survey (D-101): due after 14 days, once per account, a dismissal waits 30 days, two at most. */
describe("surveys", () => {
  let t: TestApp;
  let owner: DbHandle;
  beforeAll(async () => {
    t = await createTestApp();
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await t.close();
    await owner.close();
  });

  async function account(onboardedDaysAgo: number | null) {
    const acc = await t.createAccount("survey");
    // Preferences are tenant rows: set the onboarding date inside the workspace context.
    await owner.sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${acc.workspaceId}, true)`;
      const at =
        onboardedDaysAgo === null ? null : new Date(NOW.getTime() - onboardedDaysAgo * DAY).toISOString();
      await tx`update preferences set onboarded_at = ${at}::timestamptz where workspace_id = ${acc.workspaceId}`;
    });
    return { acc, cookie: await t.cookieFor(acc) };
  }
  const next = async (cookie: string) =>
    (await t.app.inject({ url: "/v1/surveys/next", headers: { cookie } })).json<{ survey: string | null }>()
      .survey;
  const post = (cookie: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: "POST", url: "/v1/surveys/sean_ellis", headers: { cookie, ...csrf }, payload });

  it("is not due before two weeks of use", async () => {
    const { cookie } = await account(5);
    expect(await next(cookie)).toBeNull();
    expect((await post(cookie, { answer: "very" })).json()).toMatchObject({ code: "CONFLICT" });
  });

  it("is answered once, with an optional comment, and then never offered again", async () => {
    const { acc, cookie } = await account(20);
    expect(await next(cookie)).toBe("sean_ellis");
    expect((await post(cookie, { answer: "very", comment: "  Me ahorra el lunes  " })).statusCode).toBe(204);
    expect(await next(cookie)).toBeNull();
    expect((await post(cookie, { answer: "not" })).statusCode).toBe(409);
    const rows =
      await owner.sql`select answer, comment from survey_responses where workspace_id = ${acc.workspaceId}`;
    expect(rows).toEqual([{ answer: "very", comment: "Me ahorra el lunes" }]);
  });

  it("a dismissal hides it, and invalid answers are refused", async () => {
    const { cookie } = await account(20);
    expect((await post(cookie, { answer: "maybe" })).statusCode).toBe(400);
    expect((await post(cookie, { answer: "very", comment: "x".repeat(501) })).statusCode).toBe(400);
    expect((await post(cookie, { dismiss: true })).statusCode).toBe(204);
    expect(await next(cookie)).toBeNull();
  });

  it("answers of one workspace are invisible to another", async () => {
    const a = await account(20);
    const b = await account(20);
    await post(a.cookie, { answer: "somewhat" });
    expect(await next(b.cookie)).toBe("sean_ellis");
  });
});
