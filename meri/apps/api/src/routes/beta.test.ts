import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ADMIN_WORKSPACE_CONTEXT, type DbHandle } from "@meri/db";
import { INTERNAL_HEADER } from "../plugins/internal";
import { createTestApp, csrf, INTERNAL_SECRET, type TestApp } from "../test/harness";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const ORIGIN = "http://localhost:3000";
const unique = (p: string) =>
  `${p}-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}@test.local`;

describe("closed beta (D-099)", () => {
  let t: TestApp;
  let invite: TestApp;
  let owner: DbHandle;
  beforeAll(async () => {
    t = await createTestApp();
    invite = await createTestApp({ env: { BETA_INVITE_REQUIRED: "1" } });
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  });
  afterAll(async () => {
    await t.close();
    await invite.close();
    await owner.close();
  });
  const inWaitlist = async (email: string) =>
    (await owner.sql`select 1 from waitlist where email = ${email}`).length;
  let ip = 0;
  /** Each call from its own address unless told otherwise: the per-IP limit (5/min) is tested on its own. */
  const join = (
    payload: Record<string, unknown>,
    headers: Record<string, string> = { ...csrf, origin: ORIGIN },
    remoteAddress = `10.9.0.${String((ip += 1) % 250)}`,
  ) => t.app.inject({ method: "POST", url: "/v1/waitlist", headers, payload, remoteAddress });

  it("joins the waitlist without a session, always with the same answer", async () => {
    const email = unique("wl");
    const first = await join({ email: email.toUpperCase(), consent: true, locale: "en" });
    expect(first.statusCode).toBe(202);
    const again = await join({ email, consent: true });
    expect(again.statusCode).toBe(202);
    expect(again.body).toBe(first.body);
    expect(await inWaitlist(email)).toBe(1);
  });

  it("requires consent, the CSRF header and our exact Origin; a filled honeypot stores nothing", async () => {
    const email = unique("wl-guard");
    expect((await join({ email })).statusCode).toBe(400);
    expect((await join({ email, consent: false })).statusCode).toBe(400);
    expect((await join({ email, consent: true }, { origin: ORIGIN })).statusCode).toBe(403);
    expect((await join({ email, consent: true }, { ...csrf })).statusCode).toBe(403);
    expect((await join({ email, consent: true }, { ...csrf, origin: "https://evil.test" })).statusCode).toBe(
      403,
    );
    expect((await join({ email, consent: true, website: "http://spam" })).statusCode).toBe(202);
    expect(await inWaitlist(email)).toBe(0);
  });

  it("limits sign-ups per address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1)
      codes.push((await join({ email: unique("burst"), consent: true }, undefined, "10.9.9.9")).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it("an invite-only beta refuses a new address with BETA_INVITE_REQUIRED and accepts an invited one", async () => {
    const headers = { [INTERNAL_HEADER]: INTERNAL_SECRET };
    const stranger = unique("stranger");
    const refused = await invite.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email: stranger, subject: `dev:${stranger}` },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "BETA_INVITE_REQUIRED" });
    const guest = unique("guest");
    await owner.sql`insert into beta_invites (email) values (${guest})`;
    const ok = await invite.app.inject({
      method: "POST",
      url: "/internal/auth/bootstrap",
      headers,
      payload: { email: guest, subject: `dev:${guest}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ created: true });
  });

  it("stores feedback in the workspace with the path only, limited per day, isolated between tenants", async () => {
    const a = await t.createAccount("fb-a");
    const b = await t.createAccount("fb-b");
    const cookieA = await t.cookieFor(a);
    const send = (payload: Record<string, unknown>, cookie = cookieA) =>
      t.app.inject({ method: "POST", url: "/v1/feedback", headers: { cookie, ...csrf }, payload });
    const res = await send({
      kind: "bug",
      message: "  El botón no responde  ",
      pagePath: "/hoy?q=cliente#x",
    });
    expect(res.statusCode).toBe(201);
    const rows =
      await owner.sql`select workspace_id, kind, message, page_path from feedback where id = ${res.json<{ id: string }>().id}`;
    expect(rows[0]).toMatchObject({
      workspace_id: a.workspaceId,
      kind: "bug",
      message: "El botón no responde",
      page_path: "/hoy",
    });
    expect((await send({ kind: "praise", message: "x" })).statusCode).toBe(400);
    expect((await send({ kind: "idea", message: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await send({ kind: "idea", message: "x", pagePath: "https://evil.test/a" })).statusCode).toBe(
      400,
    );
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/v1/feedback",
          headers: csrf,
          payload: { kind: "bug", message: "x" },
        })
      ).statusCode,
    ).toBe(401);
    const bRows = await owner.sql`select 1 from feedback where workspace_id = ${b.workspaceId}`;
    expect(bRows.length).toBe(0);
    // The person's own words come with the account export (F-16).
    const exported = await t.app.inject({ url: "/v1/account/export", headers: { cookie: cookieA } });
    expect(
      exported.json<{ beta: { feedback: { message: string; pagePath: string }[] } }>().beta.feedback,
    ).toEqual([expect.objectContaining({ message: "El botón no responde", pagePath: "/hoy" })]);
    // Daily cap per workspace.
    for (let i = 0; i < 19; i += 1) await send({ kind: "other", message: `n${String(i)}` });
    expect((await send({ kind: "other", message: "one too many" })).json()).toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
