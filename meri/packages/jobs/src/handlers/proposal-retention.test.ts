import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  createProposal,
  listProposals,
  resolveProposal,
  updatePreferences,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { applyMailRetention } from "./mail-purge";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** docs/06 §5, ADR 0007: dismissed or expired proposals (and their snippets) follow the retention window. */
describe("data.retention also purges resolved proposals", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
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
    ws = (await bootstrapAccount(handle.db, { email: `ret-${Date.now().toString(36)}@test.local`, now: NOW }))
      .workspaceId;
  });
  afterAll(() => handle.close());

  it("deletes old dismissed/expired proposals and keeps recent ones, pending ones and confirmed ones", async () => {
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { retentionDays: 7 }, { now: NOW });
      const make = async (title: string, at: Date, status: "pending" | "dismissed" | "expired" | "confirmed") => {
        const p = await createProposal(tx, ws, { kind: "capture", payload: { title, quote: "cita del correo" } }, at);
        if (status !== "pending") await resolveProposal(tx, ws, p.id, { status, action: status }, at);
      };
      await make("old dismissed", daysAgo(10), "dismissed");
      await make("old expired", daysAgo(30), "expired");
      await make("recent dismissed", daysAgo(2), "dismissed");
      await make("old pending", daysAgo(20), "pending");
      await make("old confirmed", daysAgo(20), "confirmed");
    });
    const result = await applyMailRetention(deps, ws, { maxRetentionDays: 365 });
    expect(result).toMatchObject({ retentionDays: 7, proposalsPurged: 2 });
    const left = await withWorkspace(handle.db, ws, (tx) => listProposals(tx, ws, {}, { limit: 50 }));
    expect(left.items.map((p) => p.payload.title).sort()).toEqual(["old confirmed", "old pending", "recent dismissed"]);
  });
});
