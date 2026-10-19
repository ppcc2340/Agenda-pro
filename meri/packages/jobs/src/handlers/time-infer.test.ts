import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  audit,
  bootstrapAccount,
  createClient,
  createDb,
  createTask,
  insertBlocks,
  listAudit,
  listTimeEntries,
  updateBlock,
  updatePreferences,
  updateTimeEntry,
  upsertCalendarEvent,
  withWorkspace,
  type DbHandle,
  type UserId,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { undoAuditEntry } from "./plan-apply";
import { inferTime } from "./time-infer";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const h = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const ACCOUNT = "01a15596-f037-71e4-bfce-25b2f4a80b44";

describe("time.infer (D-042): idempotent, never approves, rejected never resurrected", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  let userId: string;
  let acme: string;
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
    deps = { db: handle.db, integrations, keys: integrations.kms.keys, logger: createLogger({ name: "t", level: "silent" }), now: () => NOW };
    const account = await bootstrapAccount(handle.db, { email: `ti-${Date.now().toString(36)}@test.local`, now: NOW });
    ws = account.workspaceId;
    userId = account.userId;
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid", timeRoundingMinutes: 15 }, { now: NOW });
      acme = (await createClient(tx, ws, { name: "Acme", domains: ["acme.test"] }, NOW)).id;
      const ev = (externalId: string, start: Date, minutes: number, extra: Partial<Parameters<typeof upsertCalendarEvent>[2]> = {}) =>
        upsertCalendarEvent(
          tx,
          ws,
          {
            integrationAccountId: ACCOUNT,
            externalId,
            etag: null,
            title: `Reunión ${externalId}`,
            startsAt: start,
            endsAt: new Date(start.getTime() + minutes * 60_000),
            allDay: false,
            attendees: [],
            busy: true,
            origin: "external",
            clientId: acme,
            ...extra,
          },
          NOW,
        );
      await ev("yesterday", h(-26), 50);
      await ev("future", h(5), 60);
      await ev("noclient", h(-30), 30, { clientId: null });
      const task = await createTask(tx, ws, { title: "Informe Acme", clientId: acme, dueAt: null, kind: "deep", priority: 2, deadlineType: "soft", estimateMinutes: 60, tags: [], origin: "user" }, NOW);
      const [block] = await insertBlocks(tx, ws, [{ taskId: task.id, startsAt: h(-50), endsAt: h(-49), pinned: false, reason: [] }], 1, NOW);
      if (block) await updateBlock(tx, ws, block.id, { completedAt: h(-48) });
    });
  });
  afterAll(() => handle.close());

  it("creates suggested entries once, re-runs are no-ops, rejections stick, approvals only via user + undo", async () => {
    expect(await inferTime(deps, ws)).toEqual({ status: "done", sources: 2, inserted: 2, unassignedEvents: 1 });
    expect(await inferTime(deps, ws)).toEqual({ status: "done", sources: 2, inserted: 0, unassignedEvents: 1 });
    const list = () => withWorkspace(handle.db, ws, (tx) => listTimeEntries(tx, ws, { from: "2026-10-01", to: "2026-10-31", includeRejected: true }));
    const entries = await list();
    expect(entries.map((e) => `${e.sourceType}:${String(e.minutes)}:${e.status}`).sort()).toEqual([
      "calendar_event:60:suggested",
      "schedule_block:60:suggested",
    ]);
    expect(entries.every((e) => e.clientId === acme && e.approvedAt === null)).toBe(true);
    const event = entries.find((e) => e.sourceType === "calendar_event");
    if (!event) throw new Error("missing");
    // Rejected → re-inference does not resurrect it.
    await withWorkspace(handle.db, ws, (tx) => updateTimeEntry(tx, ws, event.id, { status: "rejected" }));
    expect((await inferTime(deps, ws)).inserted).toBe(0);
    expect((await list()).find((e) => e.id === event.id)?.status).toBe("rejected");
    // Approving is a user action; undoing it returns the entry to suggested, never leaves it approved silently.
    const block = entries.find((e) => e.sourceType === "schedule_block");
    if (!block) throw new Error("missing");
    const auditId = await withWorkspace(handle.db, ws, async (tx) => {
      await updateTimeEntry(tx, ws, block.id, { status: "approved", approvedAt: NOW });
      return audit(
        tx,
        { workspaceId: ws, actor: "user", actorUserId: userId as UserId },
        { action: "time.approved", entityType: "time_entry", entityId: block.id, before: { status: "suggested" }, after: { status: "approved" } },
      );
    });
    const undo = await undoAuditEntry(deps, ws, auditId, userId as UserId);
    expect(undo.action).toBe("time.approved");
    const after = await list();
    expect(after.find((e) => e.id === block.id)).toMatchObject({ status: "suggested", approvedAt: null });
    // Invariant: every approved entry in the log came from a user audit entry, and none is approved now.
    const actions = (await withWorkspace(handle.db, ws, (tx) => listAudit(tx, ws, 50))).items;
    expect(actions.filter((a) => a.action === "time.approved").every((a) => a.actor === "user")).toBe(true);
    expect(after.some((e) => e.status === "approved")).toBe(false);
    expect((await inferTime(deps, ws)).inserted).toBe(0);
  });
});
