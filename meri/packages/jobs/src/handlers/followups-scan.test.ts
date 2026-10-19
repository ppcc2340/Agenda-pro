import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createCommitment,
  createDb,
  getCommitment,
  listCommitments,
  listNotifications,
  listAudit,
  listProposals,
  listThreads,
  resolveProposal,
  setContactMuted,
  updatePreferences,
  upsertContact,
  upsertIntegrationAccount,
  upsertThread,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations, GMAIL_SCOPES, type Integrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { scanFollowups } from "./followups-scan";
import { applyMailRetention, purgeAccountMail } from "./mail-purge";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("followups.scan and mail purge (F-08 AC1/AC2, D-035, D-036)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let integrations: Integrations;
  let ws: WorkspaceId;
  let accountId: string;
  const me = "me@mifirma.test";

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
    ws = (await bootstrapAccount(handle.db, { email: `fu-${Date.now().toString(36)}@test.local`, now: NOW }))
      .workspaceId;
    accountId = await withWorkspace(handle.db, ws, async (tx) => {
      const a = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email: me,
          scopes: [...GMAIL_SCOPES],
          encryptedTokens: "x",
          keyId: "local",
        },
        NOW,
      );
      await upsertContact(tx, ws, { email: "ana@acme.test", name: "Ana Ruiz" });
      await upsertContact(tx, ws, { email: "luis@beta.test", name: "Luis Mora" });
      return a.id;
    });
  });
  afterAll(() => handle.close());

  it("creates one followup proposal per overdue commitment / unanswered thread, moves the commitment to at_risk, notifies once", async () => {
    const ids = await withWorkspace(handle.db, ws, async (tx) => {
      const { thread: t1 } = await upsertThread(tx, ws, {
        integrationAccountId: accountId,
        externalThreadId: "t1",
        subject: "Contrato",
        participants: [me, "ana@acme.test"],
        clientId: null,
        lastMessageAt: daysAgo(5),
        lastMessageFromMe: false,
        lastExternalMessageId: "m1",
      });
      const { thread: t2 } = await upsertThread(tx, ws, {
        integrationAccountId: accountId,
        externalThreadId: "t2",
        subject: "Presupuesto",
        participants: [me, "luis@beta.test"],
        clientId: null,
        lastMessageAt: daysAgo(6),
        lastMessageFromMe: true,
        lastExternalMessageId: "sent-1",
      });
      const overdue = await createCommitment(
        tx,
        ws,
        {
          clientId: null,
          direction: "owed_to_me",
          kind: "explicit",
          status: "confirmed",
          counterpartyEmail: "ana@acme.test",
          action: "enviar contrato firmado",
          dueAt: daysAgo(2),
          dueText: "el miércoles",
          confidence: 0.9,
          evidence: "Te envío el contrato firmado el miércoles.",
          threadId: t1.id,
          externalMessageId: "m1",
          dedupeHash: "h-overdue",
        },
        NOW,
      );
      const future = await createCommitment(
        tx,
        ws,
        {
          clientId: null,
          direction: "owed_to_me",
          kind: "explicit",
          status: "confirmed",
          counterpartyEmail: "ana@acme.test",
          action: "enviar factura",
          dueAt: new Date(NOW.getTime() + 3 * 86_400_000),
          dueText: null,
          confidence: 0.9,
          evidence: "x",
          threadId: t1.id,
          externalMessageId: "m1",
          dedupeHash: "h-future",
        },
        NOW,
      );
      return { t1: t1.id, t2: t2.id, overdue: overdue?.id ?? "", future: future?.id ?? "" };
    });
    const first = await scanFollowups(deps, ws);
    expect(first).toMatchObject({ status: "done", candidates: 2, proposals: 2, notified: true });
    const proposals = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { status: "pending", kind: "followup" }, { limit: 20 }),
    );
    expect(proposals.items).toHaveLength(2);
    const overdueProposal = proposals.items.find(
      (p) => (p.payload as { kind: string }).kind === "overdue_commitment",
    );
    expect(overdueProposal?.payload).toMatchObject({
      commitmentId: ids.overdue,
      counterpartyName: "Ana Ruiz",
      daysLate: 2,
      suggestedAction: "draft",
      externalThreadId: "t1",
    });
    expect(overdueProposal?.sourceRef?.url).toContain("#all/t1");
    const unanswered = proposals.items.find(
      (p) => (p.payload as { kind: string }).kind === "unanswered_thread",
    );
    expect(unanswered?.payload).toMatchObject({
      threadId: ids.t2,
      counterpartyEmail: "luis@beta.test",
      daysLate: 6,
    });
    expect((await withWorkspace(handle.db, ws, (tx) => getCommitment(tx, ws, ids.overdue)))?.status).toBe(
      "at_risk",
    );
    expect((await withWorkspace(handle.db, ws, (tx) => getCommitment(tx, ws, ids.future)))?.status).toBe(
      "confirmed",
    );
    const notes = await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 10 }));
    expect(notes.items.filter((n) => n.template === "followups.due")).toHaveLength(1);
    expect(notes.items[0]?.params).toEqual({ count: 2 });

    // F-08 AC1: a second scan creates nothing new (single alert per commitment/thread).
    const second = await scanFollowups(deps, ws);
    expect(second).toMatchObject({ candidates: 2, proposals: 0, notified: false });
    // Dismissing the alert is feedback (docs/05 §8): the next scan must not bring it back.
    await withWorkspace(handle.db, ws, (tx) =>
      resolveProposal(tx, ws, overdueProposal?.id ?? "", { status: "dismissed", action: "dismissed" }, NOW),
    );
    const third = await scanFollowups(deps, ws);
    expect(third).toMatchObject({ candidates: 2, proposals: 0 });
    const stillPending = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { status: "pending", kind: "followup" }, { limit: 20 }),
    );
    expect(stillPending.items).toHaveLength(1);
    const page = await withWorkspace(handle.db, ws, (tx) => listAudit(tx, ws, 50));
    expect(page.items.find((e) => e.action === "commitment.at_risk")?.actor).toBe("system");
  });

  it("honours mutes per contact (F-08 AC2): a muted counterparty yields no proposal", async () => {
    await withWorkspace(handle.db, ws, async (tx) => {
      const contacts = await import("@meri/db").then((m) => m.listContacts(tx, ws));
      const luis = contacts.find((c) => c.email === "luis@beta.test");
      await setContactMuted(tx, ws, luis?.id ?? "", true);
      await upsertThread(tx, ws, {
        integrationAccountId: accountId,
        externalThreadId: "t3",
        subject: "Otro",
        participants: [me, "luis@beta.test"],
        clientId: null,
        lastMessageAt: daysAgo(10),
        lastMessageFromMe: true,
        lastExternalMessageId: "sent-1",
      });
    });
    const res = await scanFollowups(deps, ws);
    expect(res.proposals).toBe(0);
    expect(res.candidates).toBe(1); // only the overdue commitment with Ana remains a candidate
  });

  it("retention purges old threads but keeps confirmed commitments (detached); disconnect purges everything", async () => {
    await withWorkspace(handle.db, ws, (tx) => updatePreferences(tx, ws, { retentionDays: 4 }, { now: NOW }));
    const r = await applyMailRetention(deps, ws, { maxRetentionDays: 365 });
    expect(r.retentionDays).toBe(4);
    // t1 (5 days), t2 (6 days) and t3 (10 days) are older than 4 days.
    expect(r.threads).toBe(3);
    expect(r.detachedCommitments).toBe(2);
    expect(r.expiredProposals).toBe(1); // the unanswered-thread proposal; the dismissed one was already resolved
    const auditPage = await withWorkspace(handle.db, ws, (tx) => listAudit(tx, ws, 50));
    expect(auditPage.items.find((e) => e.action === "mail.retention_applied")?.actor).toBe("system");
    const kept = await withWorkspace(handle.db, ws, (tx) =>
      listCommitments(tx, ws, { includeProposed: true }, { limit: 20 }),
    );
    expect(kept.items).toHaveLength(2);
    expect(kept.items.every((c) => c.threadId === null)).toBe(true);
    const pending = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { status: "pending", kind: "followup" }, { limit: 20 }),
    );
    expect(pending.items).toHaveLength(0);

    await withWorkspace(handle.db, ws, async (tx) => {
      const { thread } = await upsertThread(tx, ws, {
        integrationAccountId: accountId,
        externalThreadId: "t4",
        subject: "Nuevo",
        participants: [me, "ana@acme.test"],
        clientId: null,
        lastMessageAt: daysAgo(1),
        lastMessageFromMe: false,
        lastExternalMessageId: "m4",
      });
      await createCommitment(
        tx,
        ws,
        {
          clientId: null,
          direction: "owed_to_me",
          kind: "inferred",
          status: "proposed",
          counterpartyEmail: "ana@acme.test",
          action: "x",
          dueAt: null,
          dueText: null,
          confidence: 0.6,
          evidence: "x",
          threadId: thread.id,
          externalMessageId: "m4",
          dedupeHash: "h-proposed",
        },
        NOW,
      );
    });
    const purge = await withWorkspace(handle.db, ws, (tx) => purgeAccountMail(tx, ws, accountId, NOW));
    expect(purge).toEqual({
      threads: 1,
      proposedCommitments: 1,
      detachedCommitments: 0,
      expiredProposals: 0,
    });
    expect(await withWorkspace(handle.db, ws, (tx) => listThreads(tx, ws, { limit: 10 }))).toHaveLength(0);
    const after = await withWorkspace(handle.db, ws, (tx) =>
      listCommitments(tx, ws, { includeProposed: true }, { limit: 20 }),
    );
    expect(after.items.map((c) => c.status).sort()).toEqual(["at_risk", "confirmed"]);
  });
});
