import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { wouldCreateCycle } from "@meri/core";
import {
  TASK_STATUSES,
  TaskInputSchema,
  TaskPatchSchema,
  audit,
  listClients,
  projectExists,
  type WorkspaceId,
  type WorkspaceTx,
  createTask,
  getTask,
  listOpenTasks,
  listTasks,
  replaceDependencies,
  softDeleteTask,
  updateTask,
  type TaskView,
} from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const TaskViewSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  projectId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  kind: z.enum(["deep", "shallow"]),
  priority: z.number(),
  dueAt: z.string().datetime().nullable(),
  deadlineType: z.enum(["soft", "hard"]),
  estimateMinutes: z.number().nullable(),
  tags: z.array(z.string()),
  origin: z.enum(["user", "ai_confirmed", "system", "integration"]),
  sourceCommitmentId: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  blockedBy: z.array(z.string()),
  risk: z
    .object({
      cause: z.enum(["LOW_SLACK", "BLOCKED_DEPENDENCY", "NO_CAPACITY"]),
      slackHours: z.number(),
      since: z.string(),
    })
    .nullable(),
});

export const serializeTask = (t: TaskView) => ({
  ...t,
  dueAt: iso(t.dueAt),
  completedAt: iso(t.completedAt),
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const IdParams = z.object({ id: z.string().uuid() });
/** `z.coerce.boolean()` turns "false" into true; query flags are parsed explicitly. */
export const boolParam = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
/** Soft cap so one workspace cannot make every replan unbounded (docs/12 §5). */
export const MAX_OPEN_TASKS = 2_000;

export interface TaskRoutesOptions {
  now: () => Date;
  /** Called after any change that may affect the plan (replan trigger, phase 1 step 5). */
  onTasksChanged?: (workspaceId: string, traceId: string) => Promise<void>;
}

/** clientId/projectId/parentId must exist in this workspace: FK checks bypass RLS (docs/06). */
async function assertReferences(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  body: { clientId?: string | null; parentId?: string | null; projectId?: string | null },
): Promise<void> {
  const errors: { path: string; message: string }[] = [];
  if (body.clientId && !(await listClients(tx, workspaceId)).some((c) => c.id === body.clientId))
    errors.push({ path: "clientId", message: "Unknown client." });
  if (body.parentId && !(await getTask(tx, workspaceId, body.parentId)))
    errors.push({ path: "parentId", message: "Unknown parent task." });
  if (body.projectId && !(await projectExists(tx, workspaceId, body.projectId)))
    errors.push({ path: "projectId", message: "Unknown project." });
  if (errors.length > 0) throw new ApiError("VALIDATION_FAILED", "Invalid references.", errors);
}

export function taskRoutes(app: FastifyInstance, options: TaskRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = async (workspaceId: string, traceId: string) => {
    if (options.onTasksChanged) await options.onTasksChanged(workspaceId, traceId);
  };

  r.get(
    "/v1/tasks",
    {
      preHandler: requireSession,
      schema: {
        tags: ["tasks"],
        querystring: z.object({
          status: z.enum(TASK_STATUSES).optional(),
          clientId: z.string().uuid().optional(),
          dueBefore: z.string().datetime({ offset: true }).optional(),
          includeCompleted: boolParam,
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ items: z.array(TaskViewSchema), nextCursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const q = request.query;
      const page = await request.withWorkspace((tx) =>
        listTasks(
          tx,
          session.workspaceId,
          {
            status: q.status,
            clientId: q.clientId,
            dueBefore: q.dueBefore ? new Date(q.dueBefore) : undefined,
            includeCompleted: q.includeCompleted,
          },
          { limit: q.limit, cursor: q.cursor },
        ),
      );
      return { items: page.items.map(serializeTask), nextCursor: page.nextCursor };
    },
  );

  r.post(
    "/v1/tasks",
    {
      preHandler: requireSession,
      schema: { tags: ["tasks"], body: TaskInputSchema, response: { 201: TaskViewSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const task = await request.withWorkspace(async (tx) => {
        await assertReferences(tx, session.workspaceId, request.body);
        if ((await listOpenTasks(tx, session.workspaceId)).length >= MAX_OPEN_TASKS)
          throw new ApiError(
            "VALIDATION_FAILED",
            `At most ${String(MAX_OPEN_TASKS)} open tasks per workspace.`,
          );
        const created = await createTask(tx, session.workspaceId, request.body, now);
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          { action: "task.created", entityType: "task", entityId: created.id, after: serializeTask(created) },
        );
        return created;
      });
      await changed(session.workspaceId, request.id);
      return reply.status(201).send(serializeTask(task));
    },
  );

  r.get(
    "/v1/tasks/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["tasks"], params: IdParams, response: { 200: TaskViewSchema } },
    },
    async (request) => {
      const session = sessionOf(request);
      const task = await request.withWorkspace((tx) => getTask(tx, session.workspaceId, request.params.id));
      if (!task) throw new ApiError("NOT_FOUND", "Task not found.");
      return serializeTask(task);
    },
  );

  r.patch(
    "/v1/tasks/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["tasks"], params: IdParams, body: TaskPatchSchema, response: { 200: TaskViewSchema } },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const task = await request.withWorkspace(async (tx) => {
        const before = await getTask(tx, session.workspaceId, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Task not found.");
        await assertReferences(tx, session.workspaceId, request.body);
        const after = await updateTask(tx, session.workspaceId, request.params.id, request.body, now);
        if (!after) throw new ApiError("NOT_FOUND", "Task not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action:
              before.status !== after.status && after.status === "completed"
                ? "task.completed"
                : "task.updated",
            entityType: "task",
            entityId: after.id,
            before: serializeTask(before),
            after: serializeTask(after),
          },
        );
        return after;
      });
      await changed(session.workspaceId, request.id);
      return serializeTask(task);
    },
  );

  r.delete(
    "/v1/tasks/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["tasks"], params: IdParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      await request.withWorkspace(async (tx) => {
        const before = await softDeleteTask(tx, session.workspaceId, request.params.id, now);
        if (!before) throw new ApiError("NOT_FOUND", "Task not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          { action: "task.deleted", entityType: "task", entityId: before.id, before: serializeTask(before) },
        );
      });
      await changed(session.workspaceId, request.id);
      return reply.status(204).send(null);
    },
  );

  r.put(
    "/v1/tasks/:id/dependencies",
    {
      preHandler: requireSession,
      schema: {
        tags: ["tasks"],
        params: IdParams,
        body: z.object({ blockedBy: z.array(z.string().uuid()).max(50) }),
        response: { 200: TaskViewSchema },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const task = await request.withWorkspace(async (tx) => {
        const current = await getTask(tx, session.workspaceId, request.params.id);
        if (!current) throw new ApiError("NOT_FOUND", "Task not found.");
        const open = await listOpenTasks(tx, session.workspaceId);
        const known = new Set<string>(open.map((t) => t.id));
        const unknown = request.body.blockedBy.filter((id) => !known.has(id));
        if (unknown.length > 0)
          throw new ApiError(
            "VALIDATION_FAILED",
            "Unknown or completed tasks in blockedBy.",
            unknown.map((id) => ({ path: "blockedBy", message: id })),
          );
        const cycle = wouldCreateCycle(
          { blockedBy: new Map(open.map((t) => [t.id, t.blockedBy])) },
          current.id,
          request.body.blockedBy,
        );
        if (cycle)
          throw new ApiError("CONFLICT", "These dependencies would form a cycle.", [
            { path: "blockedBy", message: cycle.join(" -> ") },
          ]);
        const blockedBy = await replaceDependencies(
          tx,
          session.workspaceId,
          current.id,
          request.body.blockedBy,
        );
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "task.dependencies.updated",
            entityType: "task",
            entityId: current.id,
            before: { blockedBy: current.blockedBy },
            after: { blockedBy },
          },
        );
        return { ...current, blockedBy };
      });
      await changed(session.workspaceId, request.id);
      return serializeTask(task);
    },
  );

  done();
}
