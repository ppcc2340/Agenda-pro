import { ADMIN_WORKSPACE_CONTEXT, bootstrapAccount, createDb } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { backdateOnboarding } from "../e2e-fixtures";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

describe("pnpm e2e:fixture --onboarded-days-ago (phase 6 E2E)", () => {
  const app = createDb(APP, { max: 1 });
  const owner = createDb(ADMIN, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("moves a test account's onboarding back and refuses anything outside @meri.local", async () => {
    const now = new Date("2026-10-20T08:40:00Z");
    const email = `fixture-${Date.now().toString(36)}@meri.local`;
    const acc = await bootstrapAccount(app.db, { email, now });
    await backdateOnboarding(APP, email, 20, now);
    const [row] = await owner.sql<{ onboarded_at: Date }[]>`
      select onboarded_at from preferences where workspace_id = ${acc.workspaceId}`;
    expect(new Date(String(row?.onboarded_at)).toISOString()).toBe("2026-09-30T08:40:00.000Z");
    await expect(backdateOnboarding(APP, "someone@example.com", 20, now)).rejects.toThrow(/@meri\.local/);
    await expect(backdateOnboarding(APP, email, -1, now)).rejects.toThrow(/days/);
  });
});
