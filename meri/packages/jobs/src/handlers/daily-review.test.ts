import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  createTask,
  listNotifications,
  updatePreferences,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations, type FakeNotifier, type Integrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { dueForDigest, runDailyReview } from "./daily-review";
import { runReplan } from "./replan";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");

describe("daily.review digest (D-020)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let integrations: Integrations;
  let ws: WorkspaceId;

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
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
    };
    const acc = await bootstrapAccount(handle.db, {
      email: `digest-${Date.now().toString(36)}@test.local`,
      now: NOW,
    });
    ws = acc.workspaceId;
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid" }, { now: NOW });
      await createTask(tx, ws, { title: "Preparar reunión", kind: "shallow", estimateMinutes: 30 }, NOW);
    });
    await runReplan(deps, ws, { reason: "manual" });
  });
  afterAll(() => handle.close());

  it("selects workspaces past their work start without today's digest, per time zone", () => {
    const rows = [
      { workspaceId: "a", timezone: "Europe/Madrid", workStart: "09:00", lastDigestDay: null }, // 12:40 local → due
      { workspaceId: "b", timezone: "America/Santiago", workStart: "09:00", lastDigestDay: null }, // 07:40 local → not yet
      { workspaceId: "c", timezone: "Europe/Madrid", workStart: "09:00", lastDigestDay: "2026-10-19" }, // already sent
      { workspaceId: "d", timezone: "Not/AZone", workStart: "09:00", lastDigestDay: null }, // ignored
    ];
    expect(dueForDigest(rows, NOW)).toEqual([{ workspaceId: "a", date: "2026-10-19" }]);
  });

  it("writes one digest per day with the plan summary and delivers it through the notifier", async () => {
    const notifier = integrations.notifier as FakeNotifier;
    const first = await runDailyReview(deps, ws, { date: "2026-10-19" });
    expect(first.status).toBe("sent");
    expect(first.blocks).toBeGreaterThanOrEqual(1);
    expect(notifier.delivered.at(-1)).toMatchObject({ workspaceId: ws, kind: "digest" });
    expect(notifier.delivered.at(-1)?.body).not.toContain("Preparar reunión"); // ids only, never content
    const again = await runDailyReview(deps, ws, { date: "2026-10-19" });
    expect(again.status).toBe("duplicate");
    const notes = await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 20 }));
    const digests = notes.items.filter((n) => n.kind === "digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ template: "daily.digest", day: "2026-10-19" });
    expect(digests[0]?.params.blocks).toBe(first.blocks);
  });
});
