/**
 * Entrada (docs/13 "Propuestas"): list, confirm, edit, dismiss and batch-confirm proposals of every kind.
 * Nothing the AI or the rules produce acts until the user confirms it here (CLAUDE.md).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { gmailThreadUrl } from "@meri/core";
import {
  TaskInputSchema,
  audit,
  countActiveClients,
  createClient,
  createTask,
  getCommitment,
  getProposal,
  listClients,
  listProposals,
  relinkClientByDomains,
  resolveProposal,
  updateCommitment,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";
import { CapturePayload, CommitmentEdits, CommitmentPayload, ProposalViewSchema, serializeProposal } from "./capture";
import { ClientJson, serializeClient } from "./clients";
import { CommitmentViewSchema, serializeCommitment } from "./commitments";
import { serializeTask, TaskViewSchema } from "./tasks";

const IdParams = z.object({ id: z.string().uuid() });

/** Payload of a `followup` proposal (written by followups.scan). */
export const FollowupPayload = z.object({
  kind: z.enum(["overdue_commitment", "unanswered_thread"]),
  commitmentId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  subject: z.string().nullable(),
  action: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  counterpartyEmail: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  clientId: z.string().uuid().nullable(),
});

/** Payload of a `client_link` proposal (written by clients.scan, D-040). */
export const ClientLinkPayload = z.object({
  domain: z.string().min(3).max(253),
  suggestedName: z.string().min(1).max(120),
  contacts: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
});
const ClientLinkEdits = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
const ConfirmBody = z.object({
  edits: TaskInputSchema.partial().optional(),
  commitment: CommitmentEdits.optional(),
  client: ClientLinkEdits.optional(),
});

export interface ProposalRoutesOptions {
  now: () => Date;
  maxClientsFor: (tx: WorkspaceTx, workspaceId: WorkspaceId) => Promise<number>;
  onTasksChanged?: (workspaceId: string, traceId: string) => Promise<void>;
}

export function proposalRoutes(app: FastifyInstance, options: ProposalRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = async (workspaceId: string, traceId: string) => {
    if (options.onTasksChanged) await options.onTasksChanged(workspaceId, traceId);
  };

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
        throw new ApiError("CONFLICT", "This proposal kind cannot be confirmed as a task.");
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
          deadlineType: edits?.deadlineType ?? payload.deadlineType ?? "soft",
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
      if (
        edits?.clientId &&
        !(await listClients(tx, session.workspaceId)).some((c) => c.id === edits.clientId)
      )
        throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
          { path: "clientId", message: "Unknown client." },
        ]);
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
        threadUrl: payload.externalThreadId ? gmailThreadUrl(payload.externalThreadId) : null,
      });
    });
    if (edits?.createWaitingTask) await changed(session.workspaceId, request.id);
    return result;
  }


  /** `followup` proposals confirmed as-is become a "waiting for" task the planner keeps out of the day (F-08). */
  async function confirmFollowup(request: Parameters<typeof sessionOf>[0], id: string) {
    const session = sessionOf(request);
    const now = options.now();
    const result = await request.withWorkspace(async (tx) => {
      const proposal = await getProposal(tx, session.workspaceId, id);
      if (!proposal) throw new ApiError("NOT_FOUND", "Proposal not found.");
      if (proposal.status !== "pending")
        throw new ApiError("CONFLICT", "This proposal was already resolved.");
      const p = FollowupPayload.parse(proposal.payload);
      const who = p.counterpartyName ?? p.counterpartyEmail ?? "";
      const what = p.action ?? p.subject ?? "";
      const task = await createTask(
        tx,
        session.workspaceId,
        {
          title: `Esperando a ${who}: ${what}`.slice(0, 200),
          clientId: p.clientId,
          dueAt: p.dueAt ?? new Date(now.getTime() + 86_400_000).toISOString(),
          status: "waiting_on_third_party",
          kind: "shallow",
          estimateMinutes: 15,
          priority: 3,
          deadlineType: "soft",
          tags: ["esperando"],
          origin: "ai_confirmed",
          sourceCommitmentId: p.commitmentId,
        },
        now,
      );
      const resolved = await resolveProposal(
        tx,
        session.workspaceId,
        id,
        { status: "confirmed", action: "waiting_task", editedPayload: { taskId: task.id } },
        now,
      );
      if (!resolved) throw new ApiError("CONFLICT", "Proposal was already resolved.");
      await audit(
        tx,
        { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
        { action: "task.waiting_created", entityType: "task", entityId: task.id, after: serializeTask(task) },
      );
      return task;
    });
    await changed(session.workspaceId, request.id);
    return result;
  }

  /** `client_link` proposals (D-040): confirming creates the client and links its unassigned items. */
  async function confirmClientLink(
    request: Parameters<typeof sessionOf>[0],
    id: string,
    edits: z.infer<typeof ClientLinkEdits> | undefined,
  ) {
    const session = sessionOf(request);
    const now = options.now();
    return request.withWorkspace(async (tx) => {
      const proposal = await getProposal(tx, session.workspaceId, id);
      if (!proposal) throw new ApiError("NOT_FOUND", "Proposal not found.");
      if (proposal.status !== "pending")
        throw new ApiError("CONFLICT", "This proposal was already resolved.");
      const p = ClientLinkPayload.parse(proposal.payload);
      const max = await options.maxClientsFor(tx, session.workspaceId);
      if ((await countActiveClients(tx, session.workspaceId)) >= max)
        throw new ApiError(
          "ENTITLEMENT_REQUIRED",
          `Your plan allows ${String(max)} active clients. Archive one or upgrade.`,
        );
      const client = await createClient(
        tx,
        session.workspaceId,
        { name: edits?.name ?? p.suggestedName, domains: [p.domain], color: edits?.color ?? null },
        now,
      );
      const linked = await relinkClientByDomains(tx, session.workspaceId, client.id, [p.domain]);
      const edited = edits !== undefined && Object.keys(edits).length > 0;
      const resolved = await resolveProposal(
        tx,
        session.workspaceId,
        id,
        {
          status: edited ? "edited" : "confirmed",
          action: edited ? "edited" : "confirmed",
          editedPayload: { ...(edits ?? {}), clientId: client.id },
        },
        now,
      );
      if (!resolved) throw new ApiError("CONFLICT", "Proposal was already resolved.");
      await audit(
        tx,
        { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
        {
          action: "client.created",
          entityType: "client",
          entityId: client.id,
          after: { name: client.name, domains: client.domains, proposalId: id, linked },
        },
      );
      return serializeClient(client);
    });
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
          200: z.object({
            task: TaskViewSchema.nullable(),
            commitment: CommitmentViewSchema.nullable(),
            client: ClientJson.nullable(),
          }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const kind = await request.withWorkspace(
        async (tx) => (await getProposal(tx, session.workspaceId, request.params.id))?.kind ?? null,
      );
      const none = { task: null, commitment: null, client: null };
      if (kind === "commitment")
        return {
          ...none,
          commitment: await confirmCommitment(request, request.params.id, request.body?.commitment),
        };
      if (kind === "client_link")
        return { ...none, client: await confirmClientLink(request, request.params.id, request.body?.client) };
      if (kind === "followup")
        return { ...none, task: serializeTask(await confirmFollowup(request, request.params.id)) };
      return { ...none, task: serializeTask(await confirmCapture(request, request.params.id, request.body?.edits)) };
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
