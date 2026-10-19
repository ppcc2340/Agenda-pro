/**
 * planner.replan (docs/13, ADR 0003): builds PlanInput from persisted state, runs the pure planner, applies safe
 * diffs automatically (audited, undoable) and turns anything that moves a live block into a `reschedule` proposal.
 */
import { z } from "zod";
import {
  buildAlerts,
  localDateKey,
  plan,
  PlannerInputError,
  type AlertCandidate,
  type Conflict,
  type PlanInput,
  type PlannedBlock,
  type PlannerTask,
  type PlanResult,
} from "@meri/core";
import {
  applyTaskRisks,
  audit,
  countNotificationsForDay,
  createProposal,
  currentPlanVersion,
  deleteBlocks,
  expirePending,
  getPreferences,
  insertBlocks,
  insertNotification,
  insertPlanRun,
  latestPlanRun,
  listBlocks,
  listCalendarEvents,
  listOpenTasks,
  listProposals,
  lockWorkspace,
  orphanBlockIds,
  setPlanVersion,
  withWorkspace,
  type NotificationView,
  type PreferencesView,
  type ScheduleBlockView,
  type TaskRisk,
  type TaskView,
  type UserId,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import type { HandlerDeps } from "./context";
import { writeBlocksToCalendar } from "./meri-calendar";

/** Planning horizon (docs/04: two working weeks). */
export const HORIZON_DAYS = 14;
/** Tasks without an estimate are planned with these defaults (D-026). */
export const DEFAULT_ESTIMATE_MINUTES = { deep: 60, shallow: 30 } as const;

export interface ReplanOptions {
  reason: "tasks_changed" | "calendar_changed" | "day_start" | "manual";
  /** Set when a user triggered the replan from the API (audited as `user`). */
  actorUserId?: UserId | null;
}

export interface ReplanResult {
  outcome: "applied" | "proposed" | "noop" | "skipped" | "invalid";
  planVersion: number;
  applied: { added: number; removed: number } | null;
  proposalId: string | null;
  risks: number;
  conflicts: number;
  unscheduled: number;
  calendar: { created: number; deleted: number } | null;
  alerts: number;
  /** Audit entry of the applied safe diff (undo target), null otherwise. */
  auditId: string | null;
}

const skipped = (planVersion = 0): ReplanResult => ({
  outcome: "skipped",
  planVersion,
  applied: null,
  proposalId: null,
  risks: 0,
  conflicts: 0,
  unscheduled: 0,
  calendar: null,
  alerts: 0,
  auditId: null,
});

/** Reschedule proposal payload (ADR 0003 §2). Block ids let `accept` apply the diff without re-planning. */
export interface ReschedulePayload {
  basePlanVersion: number;
  added: PlannedBlock[];
  removed: { blockId: string; taskId: string; startsAt: string; endsAt: string }[];
  moved: {
    blockId: string;
    taskId: string;
    from: { startsAt: string; endsAt: string };
    to: { startsAt: string; endsAt: string };
    reasons: PlannedBlock["reasons"];
  }[];
  summary: { added: number; removed: number; moved: number };
}

const Interval = z.object({ startsAt: z.string(), endsAt: z.string() });
const ReasonSchema = z.object({
  code: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
const PlannedBlockSchema = z.object({
  taskId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  pinned: z.boolean(),
  reasons: z.array(ReasonSchema),
});
/** Boundary validation of proposal payloads read back from the database (docs/12 §2). */
export const ReschedulePayloadSchema = z.object({
  basePlanVersion: z.number().int().nonnegative(),
  added: z.array(PlannedBlockSchema),
  removed: z.array(
    z.object({ blockId: z.string(), taskId: z.string(), startsAt: z.string(), endsAt: z.string() }),
  ),
  moved: z.array(
    z.object({
      blockId: z.string(),
      taskId: z.string(),
      from: Interval,
      to: Interval,
      reasons: z.array(ReasonSchema),
    }),
  ),
  summary: z.object({ added: z.number(), removed: z.number(), moved: z.number() }),
});

/** Equality of two diffs ignoring explanation params (which may carry recomputed slack). */
export function samePayload(a: ReschedulePayload, b: ReschedulePayload): boolean {
  const key = (p: ReschedulePayload) =>
    JSON.stringify({
      v: p.basePlanVersion,
      a: p.added.map((x) => [x.taskId, x.startsAt, x.endsAt, x.pinned]),
      r: p.removed.map((x) => [x.blockId, x.startsAt, x.endsAt]),
      m: p.moved.map((x) => [x.blockId, x.to.startsAt, x.to.endsAt]),
    });
  return key(a) === key(b);
}

export function toPlannerTask(task: TaskView, openIds: Set<string>, doneMinutes: number): PlannerTask {
  const estimate = task.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES[task.kind];
  return {
    id: task.id,
    title: task.title,
    clientId: task.clientId,
    priority: task.priority,
    kind: task.kind,
    estimateMinutes: estimate,
    remainingMinutes: Math.max(0, estimate - doneMinutes),
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    deadlineType: task.deadlineType,
    blockedBy: task.blockedBy.filter((id) => openIds.has(id)),
    status: task.status,
  };
}

const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

interface Snapshot {
  prefs: PreferencesView;
  tasks: TaskView[];
  blocks: ScheduleBlockView[];
  /** Future, non-completed blocks of open tasks: the ones the planner may keep, move or drop. */
  liveBlocks: ScheduleBlockView[];
  orphans: string[];
  input: PlanInput;
}

async function snapshot(tx: WorkspaceTx, workspaceId: WorkspaceId, now: Date): Promise<Snapshot | null> {
  const prefs = await getPreferences(tx, workspaceId);
  if (!prefs) return null;
  const tasks = await listOpenTasks(tx, workspaceId);
  const openIds = new Set<string>(tasks.map((t) => t.id));
  const horizonStart = now;
  const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);
  const events = await listCalendarEvents(tx, workspaceId, { from: horizonStart, to: horizonEnd });
  const blocks = await listBlocks(tx, workspaceId);
  const doneMinutes = new Map<string, number>();
  for (const b of blocks) {
    if (b.completedAt)
      doneMinutes.set(b.taskId, (doneMinutes.get(b.taskId) ?? 0) + minutesBetween(b.startsAt, b.endsAt));
  }
  const liveBlocks = blocks.filter(
    (b) =>
      openIds.has(b.taskId) && b.completedAt === null && (b.pinned || b.startsAt.getTime() >= now.getTime()),
  );
  const orphans = await orphanBlockIds(tx, workspaceId, now);
  const input: PlanInput = {
    now: now.toISOString(),
    horizonStart: horizonStart.toISOString(),
    horizonEnd: horizonEnd.toISOString(),
    tasks: tasks.map((t) => toPlannerTask(t, openIds, doneMinutes.get(t.id) ?? 0)),
    // Meri's own mirrored events are represented by schedule_blocks; only third-party events are fixed.
    fixedEvents: events
      .filter((e) => e.origin === "external")
      .map((e) => ({
        id: e.id,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        busy: e.busy && !e.allDay,
      })),
    existingBlocks: liveBlocks.map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      pinned: b.pinned,
    })),
    preferences: {
      timezone: prefs.timezone,
      workStart: prefs.workStart,
      workEnd: prefs.workEnd,
      workDays: prefs.workDays,
      deepWorkWindows: prefs.deepWorkWindows,
      minBlockMinutes: prefs.minBlockMinutes,
      minDeepBlockMinutes: prefs.minDeepBlockMinutes,
      bufferMinutes: prefs.bufferMinutes,
      contingencyPct: prefs.contingencyPct,
      riskThresholdHours: prefs.riskThresholdHours,
    },
  };
  return { prefs, tasks, blocks, liveBlocks, orphans, input };
}

const sameInterval = (b: ScheduleBlockView, i: { startsAt: string; endsAt: string }) =>
  b.startsAt.toISOString() === i.startsAt && b.endsAt.toISOString() === i.endsAt;

function buildProposalPayload(
  result: PlanResult,
  liveBlocks: ScheduleBlockView[],
  basePlanVersion: number,
): ReschedulePayload {
  const findBlock = (taskId: string, i: { startsAt: string; endsAt: string }) =>
    liveBlocks.find((b) => b.taskId === taskId && sameInterval(b, i));
  const reasonsFor = (taskId: string, to: { startsAt: string; endsAt: string }) =>
    result.blocks.find((b) => b.taskId === taskId && b.startsAt === to.startsAt && b.endsAt === to.endsAt)
      ?.reasons ?? [];
  const removed = result.diff.removed.flatMap((r) => {
    const b = findBlock(r.taskId, r);
    return b ? [{ blockId: b.id, taskId: r.taskId, startsAt: r.startsAt, endsAt: r.endsAt }] : [];
  });
  const moved = result.diff.moved.flatMap((m) => {
    const b = findBlock(m.taskId, m.from);
    return b
      ? [{ blockId: b.id, taskId: m.taskId, from: m.from, to: m.to, reasons: reasonsFor(m.taskId, m.to) }]
      : [];
  });
  return {
    basePlanVersion,
    added: result.diff.added,
    removed,
    moved,
    summary: { added: result.diff.added.length, removed: removed.length, moved: moved.length },
  };
}

const serializeBlock = (b: ScheduleBlockView) => ({
  id: b.id,
  taskId: b.taskId,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  pinned: b.pinned,
  reason: b.reason,
  calendarEventId: b.calendarEventId,
  planVersion: b.planVersion,
});

async function persistAlerts(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  alerts: AlertCandidate[],
  day: string,
  now: Date,
): Promise<NotificationView[]> {
  const rows: NotificationView[] = [];
  for (const a of alerts) {
    const row = await insertNotification(
      tx,
      workspaceId,
      {
        kind: a.kind,
        template: a.template,
        params: a.params,
        title: a.template,
        body: JSON.stringify(a.params),
        refs: a.refs,
        day,
      },
      now,
    );
    rows.push(row);
  }
  return rows;
}

const conflictKey = (c: Conflict) => `${c.code}:${[...c.taskIds].sort().join(",")}`;

/**
 * Runs one replan for a workspace. Safe diff (only additions, plus removal of orphan blocks) → applied in place as a
 * `system` action; anything moving or removing a live block → `reschedule` proposal awaiting `POST /v1/plan/accept`.
 */
export async function runReplan(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  options: ReplanOptions,
): Promise<ReplanResult> {
  const now = deps.now();
  const actor = options.actorUserId ? ("user" as const) : ("system" as const);
  const auditCtx = { workspaceId, actor, actorUserId: options.actorUserId ?? null };

  const outcome = await withWorkspace(deps.db, workspaceId, async (tx) => {
    await lockWorkspace(tx, workspaceId); // one plan writer per workspace at a time
    const snap = await snapshot(tx, workspaceId, now);
    if (!snap) return { kind: "skipped" as const };
    let result: PlanResult;
    try {
      result = plan(snap.input);
    } catch (err) {
      if (err instanceof PlannerInputError) {
        deps.logger.error({ issues: err.issues, workspaceId }, "planner rejected the workspace state");
        return { kind: "invalid" as const };
      }
      throw err;
    }
    const baseVersion = await currentPlanVersion(tx, workspaceId);
    const previousRun = await latestPlanRun(tx, workspaceId);
    const day = localDateKey(now.getTime(), snap.prefs.timezone);
    const titles = new Map(snap.tasks.map((t) => [t.id, t.title]));
    const risksMap = new Map<string, TaskRisk>(
      result.risks.map((r) => [
        r.taskId,
        { cause: r.cause, slackHours: r.slackHours, since: now.toISOString() },
      ]),
    );
    const live = result.diff.moved.length > 0 || result.diff.removed.length > 0;
    let planVersion = baseVersion;
    let applied: ReplanResult["applied"] = null;
    let proposalId: string | null = null;
    let created: ScheduleBlockView[] = [];
    let removedBlocks: ScheduleBlockView[] = [];
    let auditId: string | null = null;
    let payload: ReschedulePayload | null = null;
    let pendingAudit: { before: unknown; after: unknown } | null = null;
    let proposalReused = false;

    if (!live) {
      removedBlocks = await deleteBlocks(tx, workspaceId, snap.orphans);
      if (result.diff.added.length > 0 || removedBlocks.length > 0) {
        planVersion = baseVersion + 1;
        await setPlanVersion(tx, workspaceId, planVersion);
        created = await insertBlocks(
          tx,
          workspaceId,
          result.diff.added.map((b) => ({
            taskId: b.taskId,
            startsAt: new Date(b.startsAt),
            endsAt: new Date(b.endsAt),
            pinned: b.pinned,
            reason: b.reasons,
          })),
          planVersion,
          now,
        );
        applied = { added: created.length, removed: removedBlocks.length };
        pendingAudit = {
          before: { planVersion: baseVersion, removed: removedBlocks.map(serializeBlock) },
          after: { planVersion, added: created.map(serializeBlock) },
        };
      }
      // Any older reschedule proposal is stale once the plan changed or is confirmed unnecessary.
      await expirePending(tx, workspaceId, "reschedule", now);
    } else {
      payload = buildProposalPayload(result, snap.liveBlocks, baseVersion);
      // Same diff as the pending proposal → keep it (stable id, no duplicate alert); otherwise replace it.
      const pending = (
        await listProposals(tx, workspaceId, { kind: "reschedule", status: "pending" }, { limit: 1 })
      ).items[0];
      const existing = pending ? ReschedulePayloadSchema.safeParse(pending.payload) : null;
      if (pending && existing?.success && samePayload(existing.data as ReschedulePayload, payload)) {
        proposalId = pending.id;
        proposalReused = true;
      } else {
        await expirePending(tx, workspaceId, "reschedule", now);
        const proposal = await createProposal(
          tx,
          workspaceId,
          {
            kind: "reschedule",
            payload: payload as unknown as Record<string, unknown>,
            confidence: null,
            explanation: options.reason,
            sourceRef: { type: "plan_run", id: options.reason },
          },
          now,
        );
        proposalId = proposal.id;
      }
    }

    const scheduled = new Set(
      live ? snap.liveBlocks.map((b) => b.taskId) : result.blocks.map((b) => b.taskId),
    );
    const { newlyAtRisk } = await applyTaskRisks(tx, workspaceId, risksMap, scheduled, now);
    const run = await insertPlanRun(
      tx,
      workspaceId,
      {
        planVersion,
        horizonStart: new Date(snap.input.horizonStart),
        horizonEnd: new Date(snap.input.horizonEnd),
        risks: result.risks,
        conflicts: result.conflicts,
        unscheduled: result.unscheduled,
        outcome: proposalId ? "proposed" : applied ? "applied" : "noop",
        proposalId,
      },
      now,
    );
    if (pendingAudit) {
      auditId = await audit(tx, auditCtx, {
        action: "plan.generated",
        entityType: "plan_run",
        entityId: run.id,
        reason: options.reason,
        before: pendingAudit.before,
        after: pendingAudit.after,
      });
    }
    const known = new Set((previousRun?.conflicts ?? []).map((c) => conflictKey(c as Conflict)));
    const alerts = buildAlerts(
      {
        newlyAtRisk,
        newConflicts: result.conflicts.filter((c) => !known.has(conflictKey(c))),
        proposal: proposalId && payload && !proposalReused ? { id: proposalId, ...payload.summary } : null,
        applied,
      },
      {
        maxPerDay: snap.prefs.maxAlertsPerDay,
        sentToday: await countNotificationsForDay(tx, workspaceId, day),
      },
    );
    const notifications = await persistAlerts(tx, workspaceId, alerts, day, now);
    return {
      kind: "done" as const,
      notifications,
      runId: run.id,
      auditId,
      planVersion,
      applied,
      proposalId,
      created,
      removedBlocks,
      titles,
      counts: {
        risks: result.risks.length,
        conflicts: result.conflicts.length,
        unscheduled: result.unscheduled.length,
      },
      alerts: alerts.length,
      autonomy: snap.prefs.autonomy,
    };
  });

  if (outcome.kind === "skipped") return skipped();
  if (outcome.kind === "invalid") return { ...skipped(), outcome: "invalid" };

  // Outbound copies after commit (fake notifier in development; never the user's Gmail).
  for (const n of outcome.notifications) {
    await deps.integrations.notifier.deliver({
      workspaceId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      refs: n.refs,
    });
  }
  // Calendar writes happen after commit (ADR 0003 §3): safe diffs reach Google only with `auto_low_risk`.
  let calendar: ReplanResult["calendar"] = null;
  if (outcome.applied && outcome.autonomy === "auto_low_risk") {
    const r = await writeBlocksToCalendar(deps, workspaceId, {
      create: outcome.created,
      remove: outcome.removedBlocks,
      titles: outcome.titles,
    });
    calendar = { created: r.created, deleted: r.deleted };
  }
  return {
    outcome: outcome.proposalId ? "proposed" : outcome.applied ? "applied" : "noop",
    planVersion: outcome.planVersion,
    applied: outcome.applied,
    proposalId: outcome.proposalId,
    ...outcome.counts,
    calendar,
    alerts: outcome.alerts,
    auditId: outcome.auditId,
  };
}
