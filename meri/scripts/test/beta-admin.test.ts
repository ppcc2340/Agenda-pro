import { createDb, joinWaitlist } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { forgetEmail, inviteEmail, TESTING_USER_CAP } from "../beta-admin";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const unique = (p: string) =>
  `${p}-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}@test.local`;

describe("pnpm beta:invite / beta:forget (D-099)", () => {
  const app = createDb(APP, { max: 1 });
  afterAll(() => app.close());

  it("invites an address once (normalized) and reports the seats against the Testing cap", async () => {
    const email = unique("Invite");
    const first = await inviteEmail(ADMIN, `  ${email.toUpperCase()} `);
    expect(first.added).toBe(true);
    expect(first.seats).toBeGreaterThan(0);
    expect(first.overCap).toBe(first.seats > TESTING_USER_CAP);
    expect((await inviteEmail(ADMIN, email)).added).toBe(false);
    await expect(inviteEmail(ADMIN, "not an email")).rejects.toThrow();
  });

  it("forgets an address from both the invitations and the waitlist", async () => {
    const email = unique("forget");
    await inviteEmail(ADMIN, email);
    await joinWaitlist(app.db, { email, locale: "es", now: new Date() });
    expect((await forgetEmail(ADMIN, email)).removed).toBe(2);
    expect((await forgetEmail(ADMIN, email)).removed).toBe(0);
  });
});
