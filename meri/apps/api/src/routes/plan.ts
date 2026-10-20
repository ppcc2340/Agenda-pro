import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  audit,
  currentPlanVersion,
  expirePending,
  getBlock,
  getPreferences,
  getTask,
  getTasksByIds,
  latestPlanRun,
  listBlocks,
  listCalendarEvents,
  listProposals,
  updateBlock,
  updateTask,
  type ScheduleBlockView,
} from "@meri/db";
import {
  acceptProposal,
  PlanApplyError,
  runReplan,
  undoAuditEntry,
  type HandlerDeps,
  type ReschedulePayload,
  track,
} from "@meri/jobs";
import { ApiError } from "../errors";
import { MarginView, marginFor } from "./plan-margin";
import { requireSession, sessionOf } from "../plugins/session";
import { serializeTask, TaskViewSchema } from "./tasks";

const Reason = z.object({ code: z.string(), params: z.record(z.unknown()) });
export const BlockView = z.object({
  id: z.string(),
  taskId: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  pinned: z.boolean(),
  reason: z.array(Reason),
  calendarEventId: z.string().nullable(),
  planVersion: z.number(),
  completedAt: z.string().datetime().nullable(),
});
const serializeBlock = (b: ScheduleBlockView) => ({
  id: b.id,
  taskId: b.taskId,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  pinned: b.pinned,
  reason: b.reason,
  calendarEventId: b.calendarEventId,
  planVersion: b.planVersion,
  completedAt: b.completedAt ? b.completedAt.toISOString() : null,
});

const RiskView = z.object({ taskId: z.string(), slackHours: z.number(), cause: z.string() });
const ConflictView = z.object({
  code: z.string(),
  taskIds: z.array(z.string()),
  details: z.record(z.union([z.string(), z.number()])),
  alternatives: z.array(z.string()),
});
const PlannedBlockView = z.object({
  taskId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  pinned: z.boolean(),
  reasons: z.array(Reason),
});
const PendingProposalView = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  basePlanVersion: z.number(),
  summary: z.object({ added: z.number(), removed: z.number(), moved: z.number() }),
  added: z.array(PlannedBlockView),
  removed: z.array(
    z.object({ blockId: z.string(), taskId: z.string(), startsAt: z.string(), endsAt: z.string() }),
  ),
  moved: z.array(
    z.object({
      blockId: z.string(),
      taskId: z.string(),
      from: z.object({ startsAt: z.string(), endsAt: z.string() }),
      to: z.object({ startsAt: z.string(), endsAt: z.string() }),
      reasons: z.array(Reason),
    }),
  ),
});

export const PlanView = z.object({
  planVersion: z.number(),
  generatedAt: z.string().datetime().nullable(),
  blocks: z.array(BlockView),
  tasks: z.array(TaskViewSchema),
  risks: z.array(RiskView),
  conflicts: z.array(ConflictView),
  unscheduled: z.array(z.object({ taskId: z.string(), reason: z.string() })),
  pendingProposal: PendingProposalView.nullable(),
  /** Contingency reserve per day (D-051): drawn hatched at the end of the day, never a block. */
  margin: z.array(MarginView),
});

const ReplanResultView = z.object({
  outcome: z.enum(["applied", "proposed", "noop", "skipped", "invalid"]),
  planVersion: z.number(),
  applied: z.object({ added: z.number(), removed: z.number() }).nullable(),
  proposalId: z.string().nullable(),
  risks: z.number(),
  conflicts: z.number(),
  unscheduled: z.number(),
  calendar: z.object({ created: z.number(), deleted: z.number() }).nullable(),
  alerts: z.number(),
  /** Audit entry of an applied safe diff (undo target); null otherwise. */
  auditId: z.string().nullable(),
});

const IdParams = z.object({ id: z.string().uuid() });

const mapApplyError = (err: unknown): never => {
  if (err instanceof PlanApplyError) throw new ApiError(err.code, err.message);
  throw err;
};

export interface PlanRoutesOptions {
  deps: HandlerDeps;
  onTasksChanged?: ((workspaceId: string, traceId: string) => Promise<void>) | undefined;
}

export function planRoutes(app: FastifyInstance, options: PlanRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const depsFor = (traceId: string): HandlerDeps => ({
    ...options.deps,
    logger: options.deps.logger.child({ traceId }),
  });
  const changed = async (workspaceId: string, traceId: string) => {
    if (options.onTasksChanged) await options.onTasksChanged(workspaceId, traceId);
  };

  /** Current plan: persisted blocks plus the risks/conflicts of the last run (never plans on request, docs/04). */
  r.get(
    "/v1/plan",
    {
      preHandler: requireSession,
      schema: {
        tags: ["plan"],
        querystring: z.object({
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
        }),
        response: { 200: PlanView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const ws = session.workspaceId;
      const now = options.deps.now();
      const from = request.query.from ? new Date(request.query.from) : new Date(now.getTime() - 86_400_000);
      const to = request.query.to ? new Date(request.query.to) : new Date(now.getTime() + 14 * 86_400_000);
      if (from >= to) throw new ApiError("VALIDATION_FAILED", "`from` must be before `to`.");
      if (to.getTime() - from.getTime() > 62 * 86_400_000)
        throw new ApiError("VALIDATION_FAILED", "Range must be at most 62 days.");
      return request.withWorkspace(async (tx) => {
        const blocks = await listBlocks(tx, ws, { from, to });
        const run = await latestPlanRun(tx, ws);
        const pending = await listProposals(tx, ws, { kind: "reschedule", status: "pending" }, { limit: 1 });
        const proposal = pending.items[0];
        const payload = proposal ? (proposal.payload as unknown as ReschedulePayload) : null;
        const taskIds = [
          ...blocks.map((b) => b.taskId),
          ...(run?.risks ?? []).map((x) => x.taskId),
          ...(run?.conflicts ?? []).flatMap((c) => c.taskIds),
          ...(run?.unscheduled ?? []).map((u) => u.taskId),
          ...(payload?.added ?? []).map((b) => b.taskId),
          ...(payload?.moved ?? []).map((b) => b.taskId),
        ];
        const tasks = await getTasksByIds(tx, ws, [...new Set(taskIds)]);
        const prefs = await getPreferences(tx, ws);
        const events = await listCalendarEvents(tx, ws, { from, to });
        return {
          margin: marginFor(prefs, events, blocks, { now, from, to }),
          planVersion: await currentPlanVersion(tx, ws),
          generatedAt: run ? run.createdAt.toISOString() : null,
          blocks: blocks.map(serializeBlock),
          tasks: [...tasks.values()].map(serializeTask),
          risks: run?.risks ?? [],
          conflicts: run?.conflicts ?? [],
          unscheduled: run?.unscheduled ?? [],
          pendingProposal:
            proposal && payload
              ? {
                  id: proposal.id,
                  createdAt: proposal.createdAt.toISOString(),
                  basePlanVersion: payload.basePlanVersion,
                  summary: payload.summary,
                  added: payload.added,
                  removed: payload.removed,
                  moved: payload.moved,
                }
              : null,
        };
      });
    },
  );

  /** Runs the planner now (synchronously) for this workspace: safe diff applied, otherwise a proposal. */
  r.post(
    "/v1/plan/replan",
    {
      preHandler: requireSession,
      // The planner runs inline: a tight per-user budget on top of the global limit (docs/12 §5).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["plan"], response: { 200: ReplanResultView } },
    },
    async (request) => {
      const session = sessionOf(request);
      return runReplan(depsFor(request.id), session.workspaceId, {
        reason: "manual",
        actorUserId: session.userId,
      });
    },
  );

  r.post(
    "/v1/plan/accept",
    {
      preHandler: requireSession,
      schema: {
        tags: ["plan"],
        body: z.object({ proposalId: z.string().uuid() }),
        response: {
          200: z.object({
            planVersion: z.number(),
            added: z.number(),
            removed: z.number(),
            auditId: z.string(),
            calendar: z.object({ created: z.number(), deleted: z.number() }).nullable(),
          }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const result = await acceptProposal(
        depsFor(request.id),
        session.workspaceId,
        request.body.proposalId,
        session.userId,
      ).catch(mapApplyError);
      track(options.deps.integrations.analytics, "plan_accepted", session.workspaceId, {
        proposalId: request.body.proposalId,
        changes: result.added + result.removed,
      });
      await changed(session.workspaceId, request.id);
      return result;
    },
  );

  r.post(
    "/v1/plan/blocks/:id/pin",
    {
      preHandler: requireSession,
      schema: {
        tags: ["plan"],
        params: IdParams,
        body: z.object({ pinned: z.boolean() }),
        response: { 200: BlockView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const ws = session.workspaceId;
      const now = options.deps.now();
      const block = await request.withWorkspace(async (tx) => {
        const before = await getBlock(tx, ws, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Block not found.");
        if (before.pinned === request.body.pinned) return before;
        const after = await updateBlock(tx, ws, before.id, { pinned: request.body.pinned });
        if (!after) throw new ApiError("NOT_FOUND", "Block not found.");
        await expirePending(tx, ws, "reschedule", now); // the pending diff no longer describes this plan
        await audit(
          tx,
          { workspaceId: ws, actor: "user", actorUserId: session.userId },
          {
            action: "block.pinned",
            entityType: "schedule_block",
            entityId: after.id,
            before: { pinned: before.pinned },
            after: { pinned: after.pinned },
          },
        );
        return after;
      });
      await changed(ws, request.id);
      return serializeBlock(block);
    },
  );

  /** Marks a block as done; with `taskDone` (default true) the task is completed too. Undoable. */
  r.post(
    "/v1/plan/blocks/:id/complete",
    {
      preHandler: requireSession,
      schema: {
        tags: ["plan"],
        params: IdParams,
        body: z.object({ taskDone: z.boolean().default(true) }).default({ taskDone: true }),
        response: { 200: z.object({ block: BlockView, task: TaskViewSchema.nullable() }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const ws = session.workspaceId;
      const now = options.deps.now();
      const result = await request.withWorkspace(async (tx) => {
        const before = await getBlock(tx, ws, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Block not found.");
        if (before.completedAt) throw new ApiError("CONFLICT", "Block already completed.");
        const block = await updateBlock(tx, ws, before.id, { completedAt: now });
        if (!block) throw new ApiError("NOT_FOUND", "Block not found.");
        await expirePending(tx, ws, "reschedule", now);
        const task = await getTask(tx, ws, before.taskId);
        let updated = task;
        if (request.body.taskDone && task && task.status !== "completed") {
          updated = await updateTask(tx, ws, task.id, { status: "completed" }, now);
        }
        await audit(
          tx,
          { workspaceId: ws, actor: "user", actorUserId: session.userId },
          {
            action: "block.completed",
            entityType: "schedule_block",
            entityId: block.id,
            before: { completedAt: null },
            after: {
              completedAt: now.toISOString(),
              taskId: before.taskId,
              taskCompleted: Boolean(request.body.taskDone && task && task.status !== "completed"),
              previousStatus: task?.status ?? null,
            },
          },
        );
        return { block, task: updated };
      });
      await changed(ws, request.id);
      return { block: serializeBlock(result.block), task: result.task ? serializeTask(result.task) : null };
    },
  );

  /** Append-only undo (D-023). */
  r.post(
    "/v1/audit/:id/undo",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        params: IdParams,
        response: {
          200: z.object({
            auditId: z.string(),
            action: z.string(),
            calendar: z.object({ created: z.number(), deleted: z.number() }).nullable(),
          }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const result = await undoAuditEntry(
        depsFor(request.id),
        session.workspaceId,
        request.params.id,
        session.userId,
      ).catch(mapApplyError);
      await changed(session.workspaceId, request.id);
      return result;
    },
  );

  done();
}
