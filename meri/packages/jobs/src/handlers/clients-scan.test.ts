import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  addMailExclusion,
  bootstrapAccount,
  createClient,
  createDb,
  listProposals,
  resolveProposal,
  upsertContact,
  upsertIntegrationAccount,
  upsertThread,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations, GMAIL_SCOPES } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { scanClients } from "./clients-scan";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");

describe("clients.scan (D-040)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  const me = "yo@mifirma.test";

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    });
    const integrations = createIntegrations(
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
    ws = (await bootstrapAccount(handle.db, { email: `cs-${Date.now().toString(36)}@test.local`, now: NOW }))
      .workspaceId;
    await withWorkspace(handle.db, ws, async (tx) => {
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
      await createClient(tx, ws, { name: "Globex", domains: ["globex.test"] }, NOW);
      await addMailExclusion(tx, ws, { kind: "domain", value: "spam.test" });
      const people = [
        "ana@acme.test",
        "bea@acme.test",
        "carlos@gmail.com",
        "dani@gmail.com",
        "eva@gmail.com",
        "socio@mifirma.test",
        "otro@mifirma.test",
        "tercero@mifirma.test",
        "x@globex.test",
        "y@globex.test",
        "z@globex.test",
        "n1@spam.test",
        "n2@spam.test",
        "n3@spam.test",
        "solo@tiny.test",
      ];
      for (const email of people) await upsertContact(tx, ws, { email, name: null });
      await upsertThread(tx, ws, {
        integrationAccountId: a.id,
        externalThreadId: "t-acme",
        subject: "Contrato",
        participants: [me, "Ana@acme.test"],
        clientId: null,
        lastMessageAt: NOW,
        lastMessageFromMe: false,
        lastExternalMessageId: "m1",
      });
    });
  });
  afterAll(() => handle.close());

  it("proposes only real domains seen ≥ 3 times and never re-proposes a dismissed one", async () => {
    const first = await scanClients(deps, ws);
    expect(first).toEqual({ status: "done", candidates: 1, proposals: 1 });
    const pending = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { status: "pending", kind: "client_link" }, { limit: 10 }),
    );
    expect(pending.items.map((p) => p.payload)).toEqual([
      { domain: "acme.test", suggestedName: "Acme", contacts: 2, threads: 1 },
    ]);
    // Idempotent while pending.
    expect(await scanClients(deps, ws)).toEqual({ status: "done", candidates: 1, proposals: 0 });
    const id = pending.items[0]?.id ?? "";
    await withWorkspace(handle.db, ws, (tx) =>
      resolveProposal(tx, ws, id, { status: "dismissed", action: "dismissed" }, NOW),
    );
    // Dismissed = feedback: the domain is never proposed again.
    expect(await scanClients(deps, ws)).toEqual({ status: "done", candidates: 1, proposals: 0 });
  });
});
