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
import { createIntegrations } from "@meri/integrations";
import type { HandlerDeps } from "./handlers/context";
import { dueForClose, localDayRange, runDailyClose } from "./reviews";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T17:30:00Z"); // 19:30 in Madrid

describe("daily.close (D-064)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 13).toString("base64"),
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
    ws = (await bootstrapAccount(handle.db, { email: `close-${crypto.randomUUID()}@test.local`, now: NOW }))
      .workspaceId;
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid" }, { now: NOW });
      await createTask(tx, ws, { title: "Hecha hoy", status: "completed" }, NOW);
    });
  });
  afterAll(() => handle.close());

  it("leaves one close notification per local day with counts only", async () => {
    expect(await runDailyClose(deps, ws, { date: "2026-10-20" })).toEqual({
      status: "sent",
      done: 1,
      toReschedule: 0,
    });
    expect((await runDailyClose(deps, ws, { date: "2026-10-20" })).status).toBe("duplicate");
    const notes = (await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 10 })))
      .items;
    const close = notes.filter((n) => n.template === "daily.close");
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({
      kind: "digest",
      day: "2026-10-20",
      params: { done: 1, toReschedule: 0 },
    });
    expect(JSON.stringify(close[0]?.params)).not.toContain("Hecha hoy");
  });

  it("is due after work end, once per day, and skips invalid zones", () => {
    const row = { workspaceId: ws, timezone: "Europe/Madrid", workEnd: "18:00", lastCloseDay: null };
    expect(dueForClose([row], NOW)).toEqual([{ workspaceId: ws, date: "2026-10-20" }]);
    expect(dueForClose([{ ...row, lastCloseDay: "2026-10-20" }], NOW)).toEqual([]);
    expect(dueForClose([{ ...row, workEnd: "20:00" }], NOW)).toEqual([]);
    expect(dueForClose([{ ...row, timezone: "Not/AZone" }], NOW)).toEqual([]);
  });

  it("maps local days to UTC bounds and rejects impossible dates", () => {
    expect(localDayRange("2026-10-20", "Europe/Madrid")).toEqual({
      from: new Date("2026-10-19T22:00:00Z"),
      to: new Date("2026-10-20T22:00:00Z"),
    });
    // DST change (25 h day in Madrid).
    const dst = localDayRange("2026-10-25", "Europe/Madrid");
    expect(dst && (dst.to.getTime() - dst.from.getTime()) / 3_600_000).toBe(25);
    expect(localDayRange("2026-02-30", "Europe/Madrid")).toBeNull();
    expect(localDayRange("not-a-day", "Europe/Madrid")).toBeNull();
  });
});
