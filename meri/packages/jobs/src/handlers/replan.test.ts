import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  createTask,
  currentPlanVersion,
  insertBlocks,
  setPlanVersion,
  getAuditEntry,
  getProposal,
  latestPlanRun,
  listAudit,
  listBlocks,
  listIntegrationAccounts,
  listNotifications,
  listOpenTasks,
  listProposals,
  updatePreferences,
  updateTask,
  upsertCalendarEvent,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
  type UserId,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations, type FakeCalendar, type Integrations } from "@meri/integrations";
import { encryptTokens } from "./calendar-sync";
import type { HandlerDeps } from "./context";
import { acceptProposal, PlanApplyError, undoAuditEntry } from "./plan-apply";
import { runReplan, type ReschedulePayload } from "./replan";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
/** Monday 2026-10-19 10:40 UTC (12:40 in Europe/Madrid). */
const NOW = new Date("2026-10-19T10:40:00Z");

describe("planner.replan, accept and undo (ADR 0003)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let integrations: Integrations;
  let ws: WorkspaceId;
  let userId: UserId;
  let other: WorkspaceId;
  const email = "replan@meri.local";

  const blocksOf = (w: WorkspaceId) => withWorkspace(handle.db, w, (tx) => listBlocks(tx, w));
  const auditOf = (w: WorkspaceId) => withWorkspace(handle.db, w, (tx) => listAudit(tx, w, 50));

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
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
    const suffix = Date.now().toString(36);
    const acc = await bootstrapAccount(handle.db, { email: `replan-${suffix}@test.local`, now: NOW });
    ws = acc.workspaceId;
    userId = acc.userId;
    other = (await bootstrapAccount(handle.db, { email: `replan-b-${suffix}@test.local`, now: NOW }))
      .workspaceId;
    await withWorkspace(handle.db, ws, (tx) =>
      updatePreferences(tx, ws, { timezone: "Europe/Madrid", maxAlertsPerDay: 2 }, { now: NOW }),
    );
    // A connected (fake) Google account so accepted plans reach the calendar.
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW.toISOString(),
      scopes: [],
      externalAccountId: "sub",
      email,
    };
    await withWorkspace(handle.db, ws, async (tx) => {
      const pre = await upsertIntegrationAccount(
        tx,
        ws,
        {
          provider: "google",
          externalAccountId: "sub",
          email,
          scopes: [],
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
          scopes: [],
          encryptedTokens: blob,
          keyId: "local",
        },
        NOW,
      );
    });
  });
  afterAll(() => handle.close());

  it("skips workspaces without preferences and applies an additive plan as an audited system action", async () => {
    const empty = await runReplan(deps, ws, { reason: "manual" });
    expect(empty.outcome).toBe("noop");

    await withWorkspace(handle.db, ws, async (tx) => {
      await createTask(
        tx,
        ws,
        { title: "Informe trimestral", kind: "deep", estimateMinutes: 120, priority: 2 },
        NOW,
      );
      await createTask(
        tx,
        ws,
        { title: "Responder a Acme", kind: "shallow", estimateMinutes: 30, priority: 3 },
        NOW,
      );
    });
    const result = await runReplan(deps, ws, { reason: "tasks_changed" });
    expect(result.outcome).toBe("applied");
    expect(result.planVersion).toBe(1);
    expect(result.applied?.added).toBeGreaterThanOrEqual(2);
    expect(result.proposalId).toBeNull();
    expect(result.calendar).toBeNull(); // suggest_only: the external calendar is untouched

    const blocks = await blocksOf(ws);
    expect(blocks.length).toBe(result.applied?.added);
    expect(blocks.every((b) => b.planVersion === 1 && b.startsAt >= NOW)).toBe(true);
    const tasks = await withWorkspace(handle.db, ws, (tx) => listOpenTasks(tx, ws));
    expect(tasks.map((t) => t.status)).toEqual(["scheduled", "scheduled"]);
    const audit = await auditOf(ws);
    const generated = audit.items.find((e) => e.action === "plan.generated");
    expect(generated?.actor).toBe("system");
    expect(generated?.reason).toBe("tasks_changed");
    const run = await withWorkspace(handle.db, ws, (tx) => latestPlanRun(tx, ws));
    expect(run?.outcome).toBe("applied");
    expect(await blocksOf(other)).toEqual([]); // isolation
  });

  it("is idempotent: a second replan with no changes is a noop", async () => {
    const before = await blocksOf(ws);
    const again = await runReplan(deps, ws, { reason: "manual" });
    expect(again.outcome).toBe("noop");
    expect(await blocksOf(ws)).toEqual(before);
  });

  it("turns a move of a live block into a reschedule proposal instead of applying it", async () => {
    const [first] = await blocksOf(ws);
    if (!first) throw new Error("expected a block");
    // A new meeting lands on top of the first block: the planner must move it.
    await withWorkspace(handle.db, ws, async (tx) => {
      const [account] = await listIntegrationAccounts(tx, ws);
      await upsertCalendarEvent(
        tx,
        ws,
        {
          integrationAccountId: account?.id ?? "",
          externalId: "ext-meeting-1",
          etag: "1",
          title: "Reunión Acme",
          startsAt: new Date(first.startsAt.getTime() - 5 * 60_000),
          endsAt: new Date(first.startsAt.getTime() + 20 * 60_000),
          allDay: false,
          attendees: ["ana@acme.com"],
          busy: true,
          origin: "external",
        },
        NOW,
      );
    });
    const result = await runReplan(deps, ws, { reason: "calendar_changed" });
    expect(result.outcome).toBe("proposed");
    expect(result.proposalId).toBeTruthy();
    expect(result.planVersion).toBe(1);
    expect((await blocksOf(ws)).find((b) => b.id === first.id)).toBeDefined(); // nothing moved yet
    const proposal = await withWorkspace(handle.db, ws, (tx) => getProposal(tx, ws, result.proposalId ?? ""));
    const payload = proposal?.payload as unknown as ReschedulePayload;
    expect(payload.basePlanVersion).toBe(1);
    expect(payload.summary.moved + payload.summary.removed).toBeGreaterThan(0);
    const notes = await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 10 }));
    expect(notes.items.some((n) => n.template === "plan.proposed")).toBe(true);
  });

  it("expires the previous proposal when a new replan runs", async () => {
    const pendingBefore = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { kind: "reschedule", status: "pending" }, { limit: 10 }),
    );
    expect(pendingBefore.items).toHaveLength(1);
    const result = await runReplan(deps, ws, { reason: "manual" });
    expect(result.outcome).toBe("proposed");
    const pending = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { kind: "reschedule", status: "pending" }, { limit: 10 }),
    );
    expect(pending.items.map((p) => p.id)).toEqual([result.proposalId]);
  });

  it("accept applies the diff, writes only Meri events to the calendar and audits; a stale proposal conflicts", async () => {
    const pending = await withWorkspace(handle.db, ws, (tx) =>
      listProposals(tx, ws, { kind: "reschedule", status: "pending" }, { limit: 10 }),
    );
    const proposal = pending.items[0];
    if (!proposal) throw new Error("expected a pending proposal");
    const cal = integrations.calendarFor(email) as FakeCalendar;
    const eventsBefore = cal.events.size;

    const accepted = await acceptProposal(deps, ws, proposal.id, userId);
    expect(accepted.planVersion).toBe(2);
    expect(accepted.added).toBeGreaterThan(0);
    expect(accepted.calendar?.created).toBe(accepted.added);
    expect(cal.events.size - eventsBefore).toBe(accepted.added);
    expect([...cal.events.values()].every((e) => e.meri || e.externalId.startsWith("ext"))).toBe(true);

    const blocks = await blocksOf(ws);
    expect(blocks.filter((b) => b.planVersion === 2).every((b) => b.calendarEventId !== null)).toBe(true);
    const audit = await auditOf(ws);
    expect(audit.items[0]).toMatchObject({ action: "plan.accepted", actor: "user", actorUserId: userId });
    await expect(acceptProposal(deps, ws, proposal.id, userId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("undo restores the previous blocks append-only and cancels the Meri events; a second undo conflicts", async () => {
    const audit = await auditOf(ws);
    const accepted = audit.items.find((e) => e.action === "plan.accepted");
    if (!accepted) throw new Error("expected plan.accepted");
    const cal = integrations.calendarFor(email) as FakeCalendar;
    const removedBefore = (accepted.before as { removed: { id: string }[] }).removed.map((b) => b.id);

    const undone = await undoAuditEntry(deps, ws, accepted.id, userId);
    expect(undone.action).toBe("plan.accepted");
    expect(undone.calendar?.deleted).toBeGreaterThan(0);
    const blocks = await blocksOf(ws);
    expect(blocks.every((b) => b.planVersion === 1)).toBe(true);
    for (const id of removedBefore) expect(blocks.some((b) => b.id === id)).toBe(true);
    expect([...cal.events.values()].filter((e) => e.meri && e.status === "confirmed")).toHaveLength(0);

    const entry = await withWorkspace(handle.db, ws, (tx) => getAuditEntry(tx, ws, accepted.id));
    expect(entry?.undoneAt).toBeInstanceOf(Date);
    const latest = (await auditOf(ws)).items[0];
    expect(latest).toMatchObject({ action: "plan.accepted.undone", undoOfAuditId: accepted.id });
    await expect(undoAuditEntry(deps, ws, accepted.id, userId)).rejects.toBeInstanceOf(PlanApplyError);
    await expect(undoAuditEntry(deps, ws, latest?.id ?? "", userId)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("removes blocks of completed tasks as a safe diff and persists risk with a capped, grouped alert", async () => {
    const tasks = await withWorkspace(handle.db, ws, (tx) => listOpenTasks(tx, ws));
    const done = tasks[0];
    if (!done) throw new Error("expected a task");
    await withWorkspace(handle.db, ws, async (tx) => {
      await updateTask(tx, ws, done.id, { status: "completed" }, NOW);
      // Eight hours of work due in two hours: impossible → risk + conflict.
      await createTask(
        tx,
        ws,
        {
          title: "Entrega urgente",
          kind: "deep",
          estimateMinutes: 480,
          priority: 1,
          dueAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
          deadlineType: "hard",
        },
        NOW,
      );
    });
    const result = await runReplan(deps, ws, { reason: "tasks_changed" });
    expect(result.risks + result.conflicts).toBeGreaterThan(0);
    const blocks = await blocksOf(ws);
    expect(blocks.some((b) => b.taskId === done.id)).toBe(false);
    const open = await withWorkspace(handle.db, ws, (tx) => listOpenTasks(tx, ws));
    const urgent = open.find((t) => t.title === "Entrega urgente");
    expect(urgent?.status).toBe("at_risk");
    expect(urgent?.risk?.cause).toBe("NO_CAPACITY");
    // Risk is rule-computed (F-03 AC2): once the deadline is realistic the task leaves at_risk.
    await withWorkspace(handle.db, ws, (tx) =>
      updateTask(
        tx,
        ws,
        urgent?.id ?? "",
        { dueAt: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(), estimateMinutes: 60 },
        NOW,
      ),
    );
    await runReplan(deps, ws, { reason: "tasks_changed" });
    const relaxed = (await withWorkspace(handle.db, ws, (tx) => listOpenTasks(tx, ws))).find(
      (t) => t.id === urgent?.id,
    );
    expect(relaxed?.status).toBe("scheduled");
    expect(relaxed?.risk).toBeNull();
    const notes = await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 20 }));
    // maxAlertsPerDay = 2 for this workspace: never more than two alerts a day, however noisy the run.
    expect(notes.items.filter((n) => n.day === "2026-10-19").length).toBeLessThanOrEqual(2);
  });

  it("accept rejects a stale basePlanVersion and leaves the proposal pending", async () => {
    await withWorkspace(handle.db, ws, (tx) =>
      createTask(tx, ws, { title: "Tarea para proponer", kind: "shallow", estimateMinutes: 30 }, NOW),
    );
    await runReplan(deps, ws, { reason: "tasks_changed" });
    const [first] = (await blocksOf(ws)).filter((b) => b.completedAt === null && b.startsAt > NOW);
    if (!first) throw new Error("expected a live block");
    await withWorkspace(handle.db, ws, async (tx) => {
      const [account] = await listIntegrationAccounts(tx, ws);
      await upsertCalendarEvent(
        tx,
        ws,
        {
          integrationAccountId: account?.id ?? "",
          externalId: "ext-meeting-2",
          etag: "1",
          title: "Reunión imprevista",
          startsAt: new Date(first.startsAt.getTime() + 60_000),
          endsAt: new Date(first.startsAt.getTime() + 10 * 60_000),
          allDay: false,
          attendees: [],
          busy: true,
          origin: "external",
        },
        NOW,
      );
    });
    const proposed = await runReplan(deps, ws, { reason: "calendar_changed" });
    expect(proposed.outcome).toBe("proposed");
    // Someone bumps the plan version behind the proposal's back (a newer applied plan).
    await withWorkspace(handle.db, ws, async (tx) => {
      const version = await currentPlanVersion(tx, ws);
      await setPlanVersion(tx, ws, version + 1);
      await insertBlocks(
        tx,
        ws,
        [
          {
            taskId: first.taskId,
            startsAt: new Date(NOW.getTime() + 5 * 86_400_000),
            endsAt: new Date(NOW.getTime() + 5 * 86_400_000 + 1_800_000),
            reason: [],
          },
        ],
        version + 1,
        NOW,
      );
    });
    await expect(acceptProposal(deps, ws, proposed.proposalId ?? "", userId)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Replan first") as string,
    });
    const still = await withWorkspace(handle.db, ws, (tx) => getProposal(tx, ws, proposed.proposalId ?? ""));
    expect(still?.status).toBe("pending");
  });

  it("undo of an older plan change conflicts while a newer plan exists; third-party events stay byte-identical", async () => {
    const cal = integrations.calendarFor(email) as FakeCalendar;
    const foreignBefore = [...cal.events.values()].filter((e) => !e.meri).map((e) => ({ ...e }));
    const generated = (await auditOf(ws)).items.filter((e) => e.action === "plan.generated" && !e.undoneAt);
    const older = generated[generated.length - 1];
    const newest = generated[0];
    if (!older || !newest || older.id === newest.id) throw new Error("expected two applied plans");
    await expect(undoAuditEntry(deps, ws, older.id, userId)).rejects.toMatchObject({ code: "CONFLICT" });
    const foreignAfter = [...cal.events.values()].filter((e) => !e.meri).map((e) => ({ ...e }));
    expect(foreignAfter).toEqual(foreignBefore);
    expect((await auditOf(ws)).items.filter((e) => e.action.startsWith("integration."))).toEqual([]);
  });

  it("serializes concurrent replans of one workspace: no duplicate blocks or versions", async () => {
    const fresh = (
      await bootstrapAccount(handle.db, { email: `replan-c-${Date.now().toString(36)}@test.local`, now: NOW })
    ).workspaceId;
    await withWorkspace(handle.db, fresh, async (tx) => {
      await updatePreferences(tx, fresh, { timezone: "Europe/Madrid" }, { now: NOW });
      await createTask(tx, fresh, { title: "Una", kind: "shallow", estimateMinutes: 30 }, NOW);
      await createTask(tx, fresh, { title: "Dos", kind: "deep", estimateMinutes: 90 }, NOW);
    });
    const results = await Promise.all([
      runReplan(deps, fresh, { reason: "tasks_changed" }),
      runReplan(deps, fresh, { reason: "calendar_changed" }),
      runReplan(deps, fresh, { reason: "manual" }),
    ]);
    expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "noop")).toHaveLength(2);
    const blocks = await blocksOf(fresh);
    const perTask = new Map<string, number>();
    for (const b of blocks) perTask.set(b.taskId, (perTask.get(b.taskId) ?? 0) + 1);
    expect([...perTask.values()].every((n) => n === 1)).toBe(true);
    expect(await withWorkspace(handle.db, fresh, (tx) => currentPlanVersion(tx, fresh))).toBe(1);
  });

  it("a removal-only safe diff bumps the explicit version and can be undone (restores the block)", async () => {
    const fresh = (
      await bootstrapAccount(handle.db, { email: `replan-r-${Date.now().toString(36)}@test.local`, now: NOW })
    ).workspaceId;
    const taskId = await withWorkspace(handle.db, fresh, async (tx) => {
      await updatePreferences(tx, fresh, { timezone: "Europe/Madrid" }, { now: NOW });
      return (await createTask(tx, fresh, { title: "Breve", kind: "shallow", estimateMinutes: 30 }, NOW)).id;
    });
    expect((await runReplan(deps, fresh, { reason: "manual" })).planVersion).toBe(1);
    await withWorkspace(handle.db, fresh, (tx) =>
      updateTask(tx, fresh, taskId, { status: "completed" }, NOW),
    );
    const removal = await runReplan(deps, fresh, { reason: "tasks_changed" });
    expect(removal).toMatchObject({ outcome: "applied", planVersion: 2, applied: { added: 0, removed: 1 } });
    expect(await blocksOf(fresh)).toEqual([]);
    // Undo the removal: the explicit version makes the entry current even though no block carries v2.
    await withWorkspace(handle.db, fresh, (tx) => updateTask(tx, fresh, taskId, { status: "pending" }, NOW));
    const undone = await undoAuditEntry(deps, fresh, removal.auditId ?? "", userId);
    expect(undone.action).toBe("plan.generated");
    expect((await blocksOf(fresh)).map((b) => b.taskId)).toEqual([taskId]);
    expect(await withWorkspace(handle.db, fresh, (tx) => currentPlanVersion(tx, fresh))).toBe(1);
  });
});
