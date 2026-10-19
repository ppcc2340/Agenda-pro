import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { suggestCapture } from "@meri/ai";
import type { FeatureFlagStore } from "@meri/config";
import {
  TaskInputSchema,
  audit,
  createProposal,
  createTask,
  getCommitment,
  getPreferences,
  getProposal,
  listClients,
  listProposals,
  resolveProposal,
  updateCommitment,
  type ProposalView,
} from "@meri/db";
import type { AiClient } from "@meri/integrations";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";
import { CommitmentViewSchema, gmailThreadUrl, serializeCommitment } from "./commitments";
import { serializeTask, TaskViewSchema } from "./tasks";

const ProposalViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["capture", "commitment", "followup", "reschedule", "time_entry", "client_link"]),
  status: z.enum(["pending", "confirmed", "edited", "dismissed", "expired"]),
  payload: z.record(z.unknown()),
  confidence: z.number().nullable(),
  explanation: z.string().nullable(),
  sourceRef: z.object({ type: z.string(), id: z.string(), url: z.string().optional() }).nullable(),
  resolution: z.object({ action: z.string(), editedPayload: z.record(z.unknown()).optional() }).nullable(),
  resolvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
const serializeProposal = (p: ProposalView) => ({
  ...p,
  resolvedAt: p.resolvedAt ? p.resolvedAt.toISOString() : null,
  createdAt: p.createdAt.toISOString(),
});

/** Payload of a `capture` proposal: the raw text and the suggested task fields. */
export const CapturePayload = z.object({
  text: z.string(),
  title: z.string(),
  clientId: z.string().uuid().nullable(),
  clientName: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  dueText: z.string().nullable(),
  estimateMinutes: z.number().int().nullable(),
  priority: z.number().int().nullable(),
  kind: z.enum(["deep", "shallow"]).nullable(),
  source: z.enum(["rules", "ai"]),
});
export type CapturePayload = z.infer<typeof CapturePayload>;

/** Payload of a `commitment` proposal (written by ai.extract_commitments). */
export const CommitmentPayload = z.object({
  commitmentId: z.string().uuid(),
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  action: z.string(),
  dueAt: z.string().datetime().nullable(),
  dueText: z.string().nullable(),
  kind: z.enum(["explicit", "inferred", "suggested"]),
  confidence: z.number(),
  evidence: z.string().max(200),
  counterpartyEmail: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  clientId: z.string().nullable(),
  threadId: z.string(),
  externalThreadId: z.string(),
  subject: z.string().nullable(),
  externalMessageId: z.string(),
});
export type CommitmentPayload = z.infer<typeof CommitmentPayload>;

const IdParams = z.object({ id: z.string().uuid() });
const CommitmentEdits = z.object({
  action: z.string().trim().min(3).max(300).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  /** owed_to_me only: also create a "waiting for" task that the planner keeps out of the day (F-08). */
  createWaitingTask: z.boolean().optional(),
});
const ConfirmBody = z.object({
  edits: TaskInputSchema.partial().optional(),
  commitment: CommitmentEdits.optional(),
});

export interface CaptureRoutesOptions {
  now: () => Date;
  ai: AiClient;
  flags: FeatureFlagStore;
  onTasksChanged?: (workspaceId: string, traceId: string) => Promise<void>;
}

export function captureRoutes(app: FastifyInstance, options: CaptureRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = async (workspaceId: string, traceId: string) => {
    if (options.onTasksChanged) await options.onTasksChanged(workspaceId, traceId);
  };

  r.post(
    "/v1/capture",
    {
      preHandler: requireSession,
      schema: {
        tags: ["capture"],
        body: z.object({ text: z.string().trim().min(1).max(500) }),
        response: { 201: ProposalViewSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const { clients, timezone } = await request.withWorkspace(async (tx) => ({
        clients: await listClients(tx, session.workspaceId),
        timezone: (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC",
      }));
      const useAi = await options.flags.isEnabled("ai_capture", session.workspaceId);
      const { suggestion, source } = await suggestCapture(
        request.body.text,
        { now: now.toISOString(), timezone, clients },
        { ai: options.ai, useAi },
      );
      const payload: CapturePayload = { text: request.body.text, ...suggestion, source };
      const proposal = await request.withWorkspace(async (tx) => {
        const created = await createProposal(
          tx,
          session.workspaceId,
          {
            kind: "capture",
            payload,
            confidence: suggestion.confidence,
            explanation: source,
            sourceRef: null,
          },
          now,
        );
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "capture.created",
            entityType: "proposal",
            entityId: created.id,
            after: { title: suggestion.title, source },
          },
        );
        return created;
      });
      return reply.status(201).send(serializeProposal(proposal));
    },
  );

  r.get(
    "/v1/proposals",
    {
      preHandler: requireSession,
      schema: {
        tags: ["proposals"],
        querystring: z.object({
          status: z.enum(["pending", "confirmed", "edited", "dismissed", "expired"]).default("pending"),
          kind: z
            .enum(["capture", "commitment", "followup", "reschedule", "time_entry", "client_link"])
            .optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({ items: z.array(ProposalViewSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const q = request.query;
      const page = await request.withWorkspace((tx) =>
        listProposals(
          tx,
          session.workspaceId,
          { status: q.status, kind: q.kind },
          { limit: q.limit, cursor: q.cursor },
        ),
      );
      return { items: page.items.map(serializeProposal), nextCursor: page.nextCursor };
    },
  );

  async function confirmCapture(
    request: Parameters<typeof sessionOf>[0],
    id: string,
    edits: z.infer<typeof ConfirmBody>["edits"],
  ) {
    const session = sessionOf(request);
    const now = options.now();
    const result = await request.withWorkspace(async (tx) => {
      const proposal = await getProposal(tx, session.workspaceId, id);
      if (!proposal) throw new ApiError("NOT_FOUND", "Proposal not found.");
      if (proposal.status !== "pending")
        throw new ApiError("CONFLICT", "This proposal was already resolved.");
      if (proposal.kind !== "capture")
        throw new ApiError("CONFLICT", "Only capture and commitment proposals can be confirmed here.");
      const payload = CapturePayload.parse(proposal.payload);
      const task = await createTask(
        tx,
        session.workspaceId,
        {
          title: edits?.title ?? payload.title,
          clientId: edits?.clientId !== undefined ? edits.clientId : payload.clientId,
          dueAt: edits?.dueAt !== undefined ? edits.dueAt : payload.dueAt,
          estimateMinutes:
            edits?.estimateMinutes !== undefined ? edits.estimateMinutes : payload.estimateMinutes,
          priority: edits?.priority ?? payload.priority ?? 3,
          kind: edits?.kind ?? payload.kind ?? "shallow",
          deadlineType: edits?.deadlineType ?? "soft",
          notes: edits?.notes ?? null,
          tags: edits?.tags ?? [],
          origin: "ai_confirmed",
        },
        now,
      );
      const edited = edits !== undefined && Object.keys(edits).length > 0;
      const resolved = await resolveProposal(
        tx,
        session.workspaceId,
        id,
        {
          status: edited ? "edited" : "confirmed",
          action: edited ? "edited" : "confirmed",
          ...(edited ? { editedPayload: edits } : {}),
        },
        now,
      );
      // A concurrent confirm won the race: roll back this task instead of creating a duplicate.
      if (!resolved) throw new ApiError("CONFLICT", "Proposal was already resolved.");
      await audit(
        tx,
        { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
        {
          action: edited ? "proposal.edited" : "proposal.confirmed",
          entityType: "proposal",
          entityId: id,
          after: { taskId: task.id },
        },
      );
      await audit(
        tx,
        { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
        { action: "task.created", entityType: "task", entityId: task.id, after: serializeTask(task) },
      );
      return task;
    });
    await changed(session.workspaceId, request.id);
    return result;
  }

  /** Commitment proposals: the `proposed` row becomes confirmed (with the user's edits); feedback is recorded. */
  async function confirmCommitment(
    request: Parameters<typeof sessionOf>[0],
    id: string,
    edits: z.infer<typeof CommitmentEdits> | undefined,
  ) {
    const session = sessionOf(request);
    const now = options.now();
    const result = await request.withWorkspace(async (tx) => {
      const proposal = await getProposal(tx, session.workspaceId, id);
      if (!proposal) throw new ApiError("NOT_FOUND", "Proposal not found.");
      if (proposal.status !== "pending")
        throw new ApiError("CONFLICT", "This proposal was already resolved.");
      const payload = CommitmentPayload.parse(proposal.payload);
      const current = await getCommitment(tx, session.workspaceId, payload.commitmentId);
      if (!current) throw new ApiError("CONFLICT", "The commitment behind this proposal no longer exists.");
      const edited = edits !== undefined && Object.keys(edits).some((k) => k !== "createWaitingTask");
      let taskId: string | null = null;
      if (edits?.createWaitingTask && current.direction === "owed_to_me") {
        const who = payload.counterpartyName ?? payload.counterpartyEmail ?? "";
        const task = await createTask(
          tx,
          session.workspaceId,
          {
            title: `Esperando a ${who}: ${edits.action ?? current.action}`.slice(0, 200),
            clientId: edits.clientId !== undefined ? edits.clientId : current.clientId,
            dueAt:
              edits.dueAt !== undefined ? edits.dueAt : current.dueAt ? current.dueAt.toISOString() : null,
            status: "waiting_on_third_party",
            kind: "shallow",
            estimateMinutes: 15,
            priority: 3,
            deadlineType: "soft",
            tags: ["esperando"],
            origin: "ai_confirmed",
            sourceCommitmentId: current.id,
          },
          now,
        );
        taskId = task.id;
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "task.waiting_created",
            entityType: "task",
            entityId: task.id,
            after: serializeTask(task),
          },
        );
      }
      const updated = await updateCommitment(
        tx,
        session.workspaceId,
        current.id,
        {
          status: "confirmed",
          ...(edits?.action !== undefined ? { action: edits.action } : {}),
          ...(edits?.dueAt !== undefined ? { dueAt: edits.dueAt ? new Date(edits.dueAt) : null } : {}),
          ...(edits?.clientId !== undefined ? { clientId: edits.clientId } : {}),
          ...(taskId ? { taskId } : {}),
        },
        now,
      );
      if (!updated) throw new ApiError("CONFLICT", "The commitment behind this proposal no longer exists.");
      const resolved = await resolveProposal(
        tx,
        session.workspaceId,
        id,
        {
          status: edited ? "edited" : "confirmed",
          action: edited ? "edited" : "confirmed",
          ...(edited ? { editedPayload: edits } : {}),
        },
        now,
      );
      if (!resolved) throw new ApiError("CONFLICT", "Proposal was already resolved.");
      await audit(
        tx,
        { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
        {
          action: "commitment.confirmed",
          entityType: "commitment",
          entityId: current.id,
          before: { status: current.status, proposalId: id },
          after: { status: "confirmed", action: updated.action, dueAt: updated.dueAt, edited, taskId },
        },
      );
      return serializeCommitment(updated, {
        counterpartyName: payload.counterpartyName,
        threadUrl: gmailThreadUrl(payload.externalThreadId),
      });
    });
    if (edits?.createWaitingTask) await changed(session.workspaceId, request.id);
    return result;
  }

  r.post(
    "/v1/proposals/:id/confirm",
    {
      preHandler: requireSession,
      schema: {
        tags: ["proposals"],
        params: IdParams,
        body: ConfirmBody.optional(),
        response: {
          200: z.object({ task: TaskViewSchema.nullable(), commitment: CommitmentViewSchema.nullable() }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const kind = await request.withWorkspace(
        async (tx) => (await getProposal(tx, session.workspaceId, request.params.id))?.kind ?? null,
      );
      if (kind === "commitment")
        return {
          task: null,
          commitment: await confirmCommitment(request, request.params.id, request.body?.commitment),
        };
      return {
        task: serializeTask(await confirmCapture(request, request.params.id, request.body?.edits)),
        commitment: null,
      };
    },
  );

  r.post(
    "/v1/proposals/:id/dismiss",
    {
      preHandler: requireSession,
      schema: {
        tags: ["proposals"],
        params: IdParams,
        body: z.object({ reason: z.string().max(200).optional() }).optional(),
        response: { 200: ProposalViewSchema },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const proposal = await request.withWorkspace(async (tx) => {
        const resolved = await resolveProposal(
          tx,
          session.workspaceId,
          request.params.id,
          {
            status: "dismissed",
            action: "dismissed",
            ...(request.body?.reason ? { editedPayload: { reason: request.body.reason } } : {}),
          },
          now,
        );
        if (!resolved) throw new ApiError("NOT_FOUND", "Proposal not found or already resolved.");
        if (resolved.kind === "commitment") {
          const payload = CommitmentPayload.safeParse(resolved.payload);
          if (payload.success)
            await updateCommitment(
              tx,
              session.workspaceId,
              payload.data.commitmentId,
              { status: "dismissed" },
              now,
            );
        }
        // Dismissals are feedback (docs/05 §8): recorded, never used to act.
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "proposal.dismissed",
            entityType: "proposal",
            entityId: resolved.id,
            reason: request.body?.reason,
          },
        );
        return resolved;
      });
      return serializeProposal(proposal);
    },
  );

  r.post(
    "/v1/proposals/confirm-batch",
    {
      preHandler: requireSession,
      schema: {
        tags: ["proposals"],
        body: z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }),
        response: {
          200: z.object({
            confirmed: z.array(z.string()),
            skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const confirmed: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const id of request.body.ids) {
        const proposal = await request.withWorkspace((tx) => getProposal(tx, session.workspaceId, id));
        // Batch confirmation only for high-confidence captures (docs/13: explicit + high confidence).
        if (!proposal || proposal.status !== "pending") {
          skipped.push({ id, reason: "not_pending" });
          continue;
        }
        if ((proposal.confidence ?? 0) < 0.85) {
          skipped.push({ id, reason: "low_confidence" });
          continue;
        }
        if (proposal.kind === "commitment") {
          // docs/13: batch confirmation of commitments only for `explicit` ones.
          const payload = CommitmentPayload.safeParse(proposal.payload);
          if (!payload.success || payload.data.kind !== "explicit") {
            skipped.push({ id, reason: "not_explicit" });
            continue;
          }
          await confirmCommitment(request, id, undefined);
          confirmed.push(id);
          continue;
        }
        if (proposal.kind !== "capture") {
          skipped.push({ id, reason: "unsupported_kind" });
          continue;
        }
        await confirmCapture(request, id, undefined);
        confirmed.push(id);
      }
      return { confirmed, skipped };
    },
  );

  done();
}
