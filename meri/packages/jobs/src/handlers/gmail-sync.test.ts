import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  listContacts,
  listIntegrationAccounts,
  listThreads,
  addMailExclusion,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import {
  createIntegrations,
  GMAIL_SCOPES,
  IntegrationError,
  type FakeGmail,
  type Integrations,
} from "@meri/integrations";
import { encryptTokens } from "./calendar-sync";
import type { HandlerDeps } from "./context";
import { syncMailAccount } from "./gmail-sync";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");

describe("gmail.sync (F-07 AC3, AC4; ADR 0004)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let integrations: Integrations;
  let ws: WorkspaceId;
  let accountId: string;
  const email = "me@mifirma.test";

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    });
    integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    deps = {
      db: handle.db,
      integrations,
      keys: integrations.kms.keys,
      logger: createLogger({ name: "t", level: "silent" }),
      now: () => NOW,
    };
    ws = (
      await bootstrapAccount(handle.db, { email: `gmail-${Date.now().toString(36)}@test.local`, now: NOW })
    ).workspaceId;
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW.toISOString(),
      scopes: [...GMAIL_SCOPES],
      externalAccountId: "sub",
      email,
    };
    accountId = await withWorkspace(handle.db, ws, async (tx) => {
      const pre = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email,
          scopes: [...GMAIL_SCOPES],
          encryptedTokens: "pending",
          keyId: "local",
        },
        NOW,
      );
      const blob = await encryptTokens(deps, ws, pre.id, tokens);
      await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email,
          scopes: [...GMAIL_SCOPES],
          encryptedTokens: blob,
          keyId: "local",
        },
        NOW,
      );
      return pre.id;
    });
  });
  afterAll(() => handle.close());

  const seed = (mail: FakeGmail) => {
    const base = { to: [email], headers: {}, labels: ["INBOX"] };
    mail.addMessage({
      ...base,
      id: "m1",
      threadId: "t1",
      from: "Ana Ruiz <ana@acme.com>",
      subject: "Contrato",
      date: "2026-10-12T10:00:00Z",
      snippet: "Te envío el contrato firmado el miércoles.",
      bodyText: "Hola, te envío el contrato firmado el miércoles.\n\nUn saludo,\nAna",
    });
    mail.addMessage({
      ...base,
      id: "m2",
      threadId: "t2",
      from: "newsletter@news.example",
      headers: { "List-Unsubscribe": "<x>" },
      subject: "Boletín",
      date: "2026-10-13T10:00:00Z",
      snippet: "Boletín",
      bodyText: "Boletín semanal",
    });
    mail.addMessage({
      ...base,
      id: "m3",
      threadId: "t3",
      from: "no-reply@bank.example",
      subject: "Extracto",
      date: "2026-10-13T11:00:00Z",
      snippet: "Extracto",
      bodyText: "Tu extracto",
    });
    mail.addMessage({
      id: "m4",
      threadId: "t1",
      from: email,
      to: ["ana@acme.com"],
      headers: {},
      labels: ["SENT"],
      subject: "RE: Contrato",
      date: "2026-10-14T09:00:00Z",
      snippet: "Gracias",
      bodyText: "Gracias, quedo a la espera.",
    });
    mail.addMessage({
      ...base,
      id: "m-old",
      threadId: "t-old",
      from: "viejo@acme.com",
      subject: "Antiguo",
      date: "2026-08-01T09:00:00Z",
      snippet: "antiguo",
      bodyText: "Correo de hace meses",
    });
  };

  it("initial 30-day load indexes threads without bodies, discards automated mail, then syncs incrementally", async () => {
    const mail = integrations.mailFor(email) as FakeGmail;
    seed(mail);
    const first = await syncMailAccount(deps, ws, accountId);
    expect(first.status).toBe("synced");
    expect(first.seen).toBe(4); // the message older than 30 days is not loaded
    expect(first.discarded).toBe(2); // newsletter + no-reply (F-07 AC4)
    expect(first.changed).toHaveLength(1);
    const threads = await withWorkspace(handle.db, ws, (tx) => listThreads(tx, ws, { limit: 10 }));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      externalThreadId: "t1",
      subject: "Contrato",
      lastMessageFromMe: true,
      lastExternalMessageId: "m4",
    });
    expect(threads[0]?.participants.sort()).toEqual(["ana@acme.com", email].sort());
    // No body persisted anywhere in the index (F-07 AC3): the row has only metadata.
    expect(JSON.stringify(threads[0])).not.toContain("contrato firmado");
    const contacts = await withWorkspace(handle.db, ws, (tx) => listContacts(tx, ws));
    expect(contacts.find((c) => c.email === "ana@acme.com")?.name).toBe("Ana Ruiz");

    const again = await syncMailAccount(deps, ws, accountId);
    expect(again).toMatchObject({ status: "synced", seen: 0, changed: [] });
    mail.addMessage({
      id: "m5",
      threadId: "t1",
      from: "ana@acme.com",
      to: [email],
      headers: {},
      labels: ["INBOX"],
      subject: "RE: Contrato",
      date: "2026-10-15T09:00:00Z",
      snippet: "Adjunto",
      bodyText: "Adjunto el contrato.",
    });
    const third = await syncMailAccount(deps, ws, accountId);
    expect(third.seen).toBe(1);
    expect(third.changed).toEqual([{ threadId: threads[0]?.id, messageIds: ["m5"] }]);
  });

  it("applies user exclusions before anything is indexed and recovers from a required resync", async () => {
    const mail = integrations.mailFor(email) as FakeGmail;
    await withWorkspace(handle.db, ws, (tx) =>
      addMailExclusion(tx, ws, { kind: "domain", value: "spammy.example" }),
    );
    mail.addMessage({
      id: "m6",
      threadId: "t6",
      from: "x@spammy.example",
      to: [email],
      headers: {},
      labels: ["INBOX"],
      subject: "Oferta",
      date: "2026-10-16T09:00:00Z",
      snippet: "Oferta",
      bodyText: "Oferta",
    });
    const res = await syncMailAccount(deps, ws, accountId);
    expect(res).toMatchObject({ seen: 1, discarded: 1, changed: [] });
    const { setSyncCursor } = await import("@meri/db");
    await withWorkspace(handle.db, ws, (tx) =>
      setSyncCursor(tx, ws, accountId, "gmail.history", "999999", NOW),
    );
    const resync = await syncMailAccount(deps, ws, accountId);
    expect(resync.fullResync).toBe(true);
    expect(resync.changed).toEqual([]); // idempotent: nothing new after the replay
  });

  it("marks the account needs_reauth on AuthExpired and keeps the index", async () => {
    const mail = integrations.mailFor(email) as FakeGmail;
    const original = mail.listHistory.bind(mail);
    mail.listHistory = () => Promise.reject(new IntegrationError("AuthExpired", "gmail", "revoked"));
    const res = await syncMailAccount(deps, ws, accountId);
    mail.listHistory = original;
    expect(res.status).toBe("needs_reauth");
    const [account] = await withWorkspace(handle.db, ws, (tx) => listIntegrationAccounts(tx, ws));
    expect(account?.status).toBe("needs_reauth");
    expect((await withWorkspace(handle.db, ws, (tx) => listThreads(tx, ws, { limit: 10 }))).length).toBe(1);
  });
});
