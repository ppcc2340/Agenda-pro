import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, DEMO_USER, parseEnv, resolveModes } from "@meri/config";
import { verifyUnsubscribeToken } from "@meri/config/crypto";
import {
  ADMIN_WORKSPACE_CONTEXT,
  bootstrapAccount,
  createDb,
  insertNotification,
  softDeleteAccount,
  updatePreferences,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import type { FakeNotifier } from "@meri/integrations";
import {
  createIntegrations,
  IntegrationError,
  type Integrations,
  type Notifier,
  type OutboundEmail,
} from "@meri/integrations";
import { runNotifyEmail, type NotifyEmailDeps } from "./notify-email";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const SECRET = "x".repeat(40);
const uniq = (p: string) => `${p}-${Date.now().toString(36)}${String(Math.random()).slice(2, 6)}@test.local`;

describe("notify.email (D-113..D-116)", () => {
  let handle: DbHandle;
  let owner: DbHandle;
  let integrations: Integrations;
  let deps: NotifyEmailDeps;
  const fake = () => integrations.notifier as FakeNotifier;

  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    owner = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: SECRET,
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    deps = {
      db: handle.db,
      integrations,
      keys: integrations.kms.keys,
      logger: createLogger({ name: "jobs-test", level: "silent" }),
      now: () => NOW,
      appUrl: "https://app.example.com/",
      authSecret: SECRET,
    };
  });
  afterAll(async () => {
    await handle.close();
    await owner.close();
  });

  async function account(opts: { locale?: "es" | "en"; email?: string } = {}) {
    return bootstrapAccount(handle.db, {
      email: opts.email ?? uniq("mail"),
      ...(opts.locale ? { locale: opts.locale } : {}),
      now: NOW,
    });
  }
  async function notify(
    ws: WorkspaceId,
    over: Partial<{ kind: "digest" | "risk" | "billing" | "integration"; template: string; at: Date }> = {},
  ) {
    return withWorkspace(handle.db, ws, (tx) =>
      insertNotification(
        tx,
        ws,
        {
          kind: over.kind ?? "digest",
          template: over.template ?? "daily.digest",
          title: "Preparar demanda contra Acme",
          body: "Tarea secreta de Acme",
          params: { blocks: 3, risks: 1, proposals: 0, client: "Acme SpA" },
          refs: [],
          day: "2026-10-19",
        },
        over.at ?? NOW,
      ),
    );
  }
  const stateOf = async (id: string) =>
    (
      await owner.sql<{ email_state: string | null; emailed_at: Date | null }[]>`
      select email_state, emailed_at from notifications where id = ${id}`
    )[0];

  it("sends the digest once to the owner, with counts only and a working unsubscribe token", async () => {
    const acc = await account();
    const n = await notify(acc.workspaceId);
    const before = fake().sent.length;
    expect(await runNotifyEmail(deps, acc.workspaceId, { notificationId: n.id })).toEqual({ status: "sent" });
    expect(await runNotifyEmail(deps, acc.workspaceId, { notificationId: n.id })).toEqual({ status: "done" });
    expect(fake().sent.length).toBe(before + 1);
    const mail = fake().sent.at(-1) as OutboundEmail;
    expect(mail.to).toBe(acc.email);
    expect(mail.subject).toBe("Tu día en Meri: 3 bloques planificados");
    expect(mail.reference).toBe(n.id);
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toContain("Acme");
      expect(part).not.toContain("demanda");
    }
    const token = decodeURIComponent(new URL(mail.unsubscribeUrl).searchParams.get("t") ?? "");
    expect(mail.unsubscribeUrl.startsWith("https://app.example.com/api/v1/email/unsubscribe?t=")).toBe(true);
    expect(verifyUnsubscribeToken(SECRET, token)).toBe(acc.workspaceId);
    expect(mail.text).toContain("https://app.example.com/correo/baja?t=");
    const state = await stateOf(n.id);
    expect(state?.email_state).toBe("sent");
    expect(new Date(String(state?.emailed_at)).toISOString()).toBe(NOW.toISOString());
  });

  it("follows the preference: off sends nothing, digest skips risks, all sends them", async () => {
    const acc = await account();
    const ws = acc.workspaceId;
    const risk = await notify(ws, { kind: "risk", template: "risk.grouped" });
    expect(await runNotifyEmail(deps, ws, { notificationId: risk.id })).toEqual({
      status: "skipped",
      reason: "preference",
    });
    expect((await stateOf(risk.id))?.email_state).toBe("skipped");
    await withWorkspace(handle.db, ws, (tx) =>
      updatePreferences(tx, ws, { emailNotifications: "all" }, { now: NOW }),
    );
    const risk2 = await notify(ws, { kind: "risk", template: "risk.grouped" });
    expect(await runNotifyEmail(deps, ws, { notificationId: risk2.id })).toEqual({ status: "sent" });
    await withWorkspace(handle.db, ws, (tx) =>
      updatePreferences(tx, ws, { emailNotifications: "off" }, { now: NOW }),
    );
    const billing = await notify(ws, { kind: "billing", template: "billing.payment_failed" });
    expect(await runNotifyEmail(deps, ws, { notificationId: billing.id })).toEqual({
      status: "skipped",
      reason: "preference",
    });
  });

  it("under the default preference, account notices (payment, Google connection) are sent", async () => {
    const acc = await account();
    const ws = acc.workspaceId;
    const billing = await notify(ws, { kind: "billing", template: "billing.payment_failed" });
    expect(await runNotifyEmail(deps, ws, { notificationId: billing.id })).toEqual({ status: "sent" });
    expect(fake().sent.at(-1)?.subject).toBe("No pudimos cobrar tu suscripción de Meri");
    const reauth = await notify(ws, { kind: "integration", template: "integration.needs_reauth" });
    expect(await runNotifyEmail(deps, ws, { notificationId: reauth.id })).toEqual({ status: "sent" });
    expect(fake().sent.at(-1)?.text).toContain("https://app.example.com/control");
  });

  it("writes in the owner's language", async () => {
    const acc = await account({ locale: "en" });
    const n = await notify(acc.workspaceId);
    await runNotifyEmail(deps, acc.workspaceId, { notificationId: n.id });
    expect(fake().sent.at(-1)?.subject).toBe("Your day in Meri: 3 blocks planned");
  });

  it("never emails a stale notification, the demo account or a deleted account", async () => {
    const sentBefore = fake().sent.length;
    const acc = await account();
    const old = await notify(acc.workspaceId, { at: new Date(NOW.getTime() - 25 * 3_600_000) });
    expect(await runNotifyEmail(deps, acc.workspaceId, { notificationId: old.id })).toEqual({
      status: "skipped",
      reason: "stale",
    });
    const demo = await bootstrapAccount(handle.db, { email: DEMO_USER.email, now: NOW });
    // The demo row is shared with other suites: pin the preference so only the demo rule can skip it.
    await withWorkspace(handle.db, demo.workspaceId, (tx) =>
      updatePreferences(tx, demo.workspaceId, { emailNotifications: "digest" }, { now: NOW }),
    );
    const d = await notify(demo.workspaceId);
    expect(await runNotifyEmail(deps, demo.workspaceId, { notificationId: d.id })).toEqual({
      status: "skipped",
      reason: "demo",
    });
    const gone = await account();
    const g = await notify(gone.workspaceId);
    await softDeleteAccount(handle.db, { userId: gone.userId, workspaceId: gone.workspaceId, now: NOW });
    expect(await runNotifyEmail(deps, gone.workspaceId, { notificationId: g.id })).toEqual({
      status: "skipped",
      reason: "no_recipient",
    });
    expect(fake().sent.length).toBe(sentBefore);
  });

  it("another workspace's notification id does nothing", async () => {
    const a = await account();
    const b = await account();
    const n = await notify(a.workspaceId);
    const before = fake().sent.length;
    expect(await runNotifyEmail(deps, b.workspaceId, { notificationId: n.id })).toEqual({ status: "done" });
    expect(fake().sent.length).toBe(before);
    expect((await stateOf(n.id))?.email_state).toBeNull();
  });

  it("a permanent rejection is recorded as failed; a transient one is retried by the queue", async () => {
    const failing = (kind: "Permanent" | "Transient"): Notifier => ({
      mode: "live",
      send: () => Promise.reject(new IntegrationError(kind, "smtp", "rejected")),
    });
    const acc = await account();
    const p = await notify(acc.workspaceId);
    const permanent = { ...deps, integrations: { ...integrations, notifier: failing("Permanent") } };
    expect(await runNotifyEmail(permanent, acc.workspaceId, { notificationId: p.id })).toEqual({
      status: "failed",
    });
    expect((await stateOf(p.id))?.email_state).toBe("failed");
    const t = await notify(acc.workspaceId);
    const transient = { ...deps, integrations: { ...integrations, notifier: failing("Transient") } };
    await expect(runNotifyEmail(transient, acc.workspaceId, { notificationId: t.id })).rejects.toThrow(
      IntegrationError,
    );
    expect((await stateOf(t.id))?.email_state).toBeNull();
    expect(await runNotifyEmail(deps, acc.workspaceId, { notificationId: t.id })).toEqual({ status: "sent" });
    // Still failing just before the dispatcher's window closes: recorded as failed, never picked again.
    const late = await notify(acc.workspaceId, { at: new Date(NOW.getTime() - 101 * 60_000) });
    expect(await runNotifyEmail(transient, acc.workspaceId, { notificationId: late.id })).toEqual({
      status: "failed",
    });
    expect((await stateOf(late.id))?.email_state).toBe("failed");
  });
});
