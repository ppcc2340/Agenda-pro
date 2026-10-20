/**
 * Commitment radar and follow-ups (F-07, F-08; docs/13 "Compromisos y seguimiento"). Drafts are text until the user
 * saves them to Gmail; the recipient is always taken from the thread, never from the model. Nothing is ever sent.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { draftFollowup, templateFollowup, type FollowupInput } from "@meri/ai";
import { gmailThreadUrl, isAllowedRecipient, looksLikeInjection } from "@meri/core";
import {
  audit,
  createTask,
  getCommitment,
  getIntegrationAccount,
  getProposal,
  getThread,
  getThreadsByIds,
  listClients,
  listCommitments,
  listContacts,
  resolveProposal,
  updateCommitment,
  type CommitmentView,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { aiBudget, aiStatus, chargeAiUsage, notifyAiPaused, readTokens, type HandlerDeps } from "@meri/jobs";
import { hasGmailScopes, IntegrationError, type AiClient } from "@meri/integrations";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";
import { serializeTask, TaskViewSchema } from "./tasks";

export const CommitmentViewSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  kind: z.enum(["explicit", "inferred", "suggested"]),
  status: z.enum(["proposed", "confirmed", "fulfilled", "at_risk", "broken", "dismissed"]),
  counterpartyEmail: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  action: z.string(),
  dueAt: z.string().datetime().nullable(),
  dueText: z.string().nullable(),
  confidence: z.number().nullable(),
  evidence: z.string().nullable(),
  threadId: z.string().nullable(),
  threadUrl: z.string().nullable(),
  taskId: z.string().nullable(),
  origin: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export function serializeCommitment(
  c: CommitmentView,
  extra: { counterpartyName: string | null; threadUrl: string | null },
) {
  return {
    id: c.id,
    clientId: c.clientId,
    direction: c.direction,
    kind: c.kind,
    status: c.status,
    counterpartyEmail: c.counterpartyEmail,
    counterpartyName: extra.counterpartyName,
    action: c.action,
    dueAt: c.dueAt ? c.dueAt.toISOString() : null,
    dueText: c.dueText,
    confidence: c.confidence,
    evidence: c.evidence,
    threadId: c.threadId,
    threadUrl: extra.threadUrl,
    taskId: c.taskId,
    origin: c.origin,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z
  .object({
    status: z.enum(["confirmed", "fulfilled", "at_risk", "broken", "dismissed"]).optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    clientId: z.string().uuid().nullable().optional(),
    action: z.string().trim().min(3).max(300).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update." });

const DraftView = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  source: z.enum(["ai", "template"]),
  language: z.enum(["es", "en"]),
});

export interface CommitmentRoutesOptions {
  deps: Omit<HandlerDeps, "logger">;
  ai: AiClient;
  costCapUsd: number;
  onTasksChanged?: (workspaceId: string, traceId: string) => Promise<void>;
}

const POLICY = /https?:\/\/|\bwww\.|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/i;

export function commitmentRoutes(
  app: FastifyInstance,
  options: CommitmentRoutesOptions,
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function enrich(tx: WorkspaceTx, workspaceId: WorkspaceId, items: CommitmentView[]) {
    const contacts = new Map((await listContacts(tx, workspaceId)).map((x) => [x.email, x.name]));
    const threads = await getThreadsByIds(tx, workspaceId, [
      ...new Set(items.map((c) => c.threadId).filter((x): x is string => x !== null)),
    ]);
    return items.map((c) => {
      const thread = c.threadId ? threads.get(c.threadId) : undefined;
      return serializeCommitment(c, {
        counterpartyName: c.counterpartyEmail ? (contacts.get(c.counterpartyEmail) ?? null) : null,
        threadUrl: thread ? gmailThreadUrl(thread.externalThreadId) : null,
      });
    });
  }

  /** A client id must belong to this workspace: FK checks bypass RLS (same guard as tasks). */
  async function assertClient(
    tx: WorkspaceTx,
    workspaceId: WorkspaceId,
    clientId: string | null | undefined,
  ) {
    if (clientId && !(await listClients(tx, workspaceId)).some((c) => c.id === clientId))
      throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
        { path: "clientId", message: "Unknown client." },
      ]);
  }

  r.get(
    "/v1/commitments",
    {
      preHandler: requireSession,
      schema: {
        tags: ["commitments"],
        querystring: z.object({
          direction: z.enum(["owed_by_me", "owed_to_me"]).optional(),
          status: z.enum(["proposed", "confirmed", "fulfilled", "at_risk", "broken", "dismissed"]).optional(),
          clientId: z.string().uuid().optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        response: {
          200: z.object({ items: z.array(CommitmentViewSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const q = request.query;
      return request.withWorkspace(async (tx) => {
        const page = await listCommitments(
          tx,
          session.workspaceId,
          { direction: q.direction, status: q.status, clientId: q.clientId },
          { limit: q.limit, cursor: q.cursor },
        );
        return { items: await enrich(tx, session.workspaceId, page.items), nextCursor: page.nextCursor };
      });
    },
  );

  r.patch(
    "/v1/commitments/:id",
    {
      preHandler: requireSession,
      schema: {
        tags: ["commitments"],
        params: IdParams,
        body: PatchBody,
        response: { 200: CommitmentViewSchema },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.deps.now();
      const b = request.body;
      return request.withWorkspace(async (tx) => {
        const current = await getCommitment(tx, session.workspaceId, request.params.id);
        if (!current) throw new ApiError("NOT_FOUND", "Commitment not found.");
        if (current.status === "proposed")
          throw new ApiError("CONFLICT", "Confirm the proposal in Entrada before editing it.");
        await assertClient(tx, session.workspaceId, b.clientId);
        const updated = await updateCommitment(
          tx,
          session.workspaceId,
          current.id,
          {
            ...(b.status !== undefined ? { status: b.status } : {}),
            ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
            ...(b.clientId !== undefined ? { clientId: b.clientId } : {}),
            ...(b.action !== undefined ? { action: b.action } : {}),
          },
          now,
        );
        if (!updated) throw new ApiError("NOT_FOUND", "Commitment not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action:
              b.status === "fulfilled"
                ? "commitment.fulfilled"
                : b.status === "dismissed"
                  ? "commitment.dismissed"
                  : "commitment.updated",
            entityType: "commitment",
            entityId: current.id,
            before: { status: current.status, dueAt: current.dueAt, action: current.action },
            after: { status: updated.status, dueAt: updated.dueAt, action: updated.action },
          },
        );
        const [view] = await enrich(tx, session.workspaceId, [updated]);
        if (!view) throw new ApiError("INTERNAL");
        return view;
      });
    },
  );

  /** Loads what a follow-up needs: the commitment, its thread and the fixed recipient (docs/05 §6.5). */
  async function followupContext(
    tx: WorkspaceTx,
    ws: WorkspaceId,
    id: string,
    language: "es" | "en",
    now: Date,
  ) {
    const commitment = await getCommitment(tx, ws, id);
    if (!commitment) throw new ApiError("NOT_FOUND", "Commitment not found.");
    if (commitment.direction !== "owed_to_me")
      throw new ApiError("VALIDATION_FAILED", "Follow-ups are for commitments other people owe you.");
    if (!["confirmed", "at_risk", "broken"].includes(commitment.status))
      throw new ApiError("CONFLICT", "Confirm the commitment before following it up.");
    if (!commitment.counterpartyEmail)
      throw new ApiError("VALIDATION_FAILED", "This commitment has no counterparty to write to.");
    const thread = commitment.threadId ? await getThread(tx, ws, commitment.threadId) : null;
    const allowed = thread ? thread.participants : [commitment.counterpartyEmail];
    if (!isAllowedRecipient(commitment.counterpartyEmail, allowed))
      throw new ApiError("CONFLICT", "The counterparty is not part of the original thread.");
    const contacts = await listContacts(tx, ws);
    const name = contacts.find((c) => c.email === commitment.counterpartyEmail)?.name ?? null;
    const daysLate = commitment.dueAt
      ? Math.max(0, Math.ceil((now.getTime() - commitment.dueAt.getTime()) / 86_400_000))
      : 0;
    const input: FollowupInput = {
      language,
      counterpartyName: name,
      action: commitment.action,
      dueText: commitment.dueText,
      dueAt: commitment.dueAt ? commitment.dueAt.toISOString().slice(0, 10) : null,
      daysLate,
      subject: thread?.subject ?? null,
      myName: null,
    };
    const subject = thread?.subject
      ? /^re:/i.test(thread.subject)
        ? thread.subject
        : `Re: ${thread.subject}`
      : `${language === "en" ? "Follow-up" : "Seguimiento"}: ${commitment.action}`;
    return { commitment, thread, input, subject, to: commitment.counterpartyEmail };
  }

  /** A `proposalId` may only resolve the follow-up proposal that points at this very commitment. */
  async function resolveFollowupProposal(
    tx: WorkspaceTx,
    ws: WorkspaceId,
    proposalId: string,
    commitmentId: string,
    action: string,
    now: Date,
  ) {
    const proposal = await getProposal(tx, ws, proposalId);
    const payload = proposal?.payload as { commitmentId?: string } | undefined;
    if (!proposal || proposal.kind !== "followup" || payload?.commitmentId !== commitmentId)
      throw new ApiError("VALIDATION_FAILED", "proposalId is not a follow-up proposal of this commitment.");
    await resolveProposal(tx, ws, proposalId, { status: "confirmed", action }, now);
  }

  r.post(
    "/v1/commitments/:id/followup-draft",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["commitments"],
        params: IdParams,
        body: z.object({ language: z.enum(["es", "en"]).default("es") }).optional(),
        response: { 200: DraftView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.deps.now();
      const language = request.body?.language ?? "es";
      const ctx = await request.withWorkspace((tx) =>
        followupContext(tx, session.workspaceId, request.params.id, language, now),
      );
      const budget = await request.withWorkspace(async (tx) => {
        const decision = await aiBudget(tx, session.workspaceId, "followup_draft", {
          now,
          aiMode: options.ai.mode,
          costCapUsd: options.costCapUsd,
        });
        if (decision.reason) await notifyAiPaused(tx, session.workspaceId, decision.reason, now);
        return decision;
      });
      let body: string;
      let source: "ai" | "template" = "template";
      if (!budget.allow) {
        body = templateFollowup(ctx.input);
      } else {
        try {
          const res = await draftFollowup(options.ai, ctx.input);
          body = res.body;
          source = options.ai.mode === "live" ? "ai" : "template";
          await request.withWorkspace((tx) =>
            chargeAiUsage(tx, session.workspaceId, "followup_draft", [res.usage], { now }),
          );
        } catch (err) {
          // Provider outage or policy rejection → template (never links or instructions). Anything else is a bug.
          const expected =
            err instanceof IntegrationError ||
            (err instanceof Error && /rejected by policy/.test(err.message));
          if (!expected) throw err;
          request.log.warn(
            { err, commitmentId: ctx.commitment.id },
            "follow-up draft fell back to the template",
          );
          body = templateFollowup(ctx.input);
        }
      }
      return { to: ctx.to, subject: ctx.subject, body, source, language };
    },
  );

  r.post(
    "/v1/commitments/:id/followup-draft/save",
    {
      preHandler: requireSession,
      schema: {
        tags: ["commitments"],
        params: IdParams,
        body: z.object({
          body: z.string().trim().min(20).max(4000),
          subject: z.string().trim().min(1).max(200).optional(),
          language: z.enum(["es", "en"]).default("es"),
          proposalId: z.string().uuid().optional(),
        }),
        response: { 201: z.object({ draftId: z.string(), threadId: z.string().nullable(), to: z.string() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.deps.now();
      const b = request.body;
      // The user edits the body, but it still cannot carry links, addresses or instructions (docs/05 §6.5).
      if (
        looksLikeInjection(b.body) ||
        POLICY.test(b.body) ||
        (b.subject && (looksLikeInjection(b.subject) || POLICY.test(b.subject)))
      )
        throw new ApiError("VALIDATION_FAILED", "The draft cannot contain links, addresses or instructions.");
      const ctx = await request.withWorkspace((tx) =>
        followupContext(tx, session.workspaceId, request.params.id, b.language, now),
      );
      if (!ctx.thread) throw new ApiError("CONFLICT", "This commitment has no mail thread to reply to.");
      const accountId = ctx.thread.integrationAccountId;
      const account = await request.withWorkspace((tx) =>
        getIntegrationAccount(tx, session.workspaceId, accountId),
      );
      if (!account || !hasGmailScopes(account.scopes))
        throw new ApiError("INTEGRATION_NEEDS_REAUTH", "Gmail is not connected with draft permissions.");
      const tokens = await readTokens(options.deps, session.workspaceId, account.id);
      if (!tokens) throw new ApiError("INTEGRATION_NEEDS_REAUTH", "Gmail needs to be reconnected.");
      const inReplyTo = ctx.commitment.externalMessageId ?? ctx.thread.lastExternalMessageId;
      if (!inReplyTo) throw new ApiError("CONFLICT", "The thread has no message to reply to.");
      const mail = options.deps.integrations.mailFor(tokens.email);
      const ref = await mail.createDraft({
        threadId: ctx.thread.externalThreadId,
        inReplyToMessageId: inReplyTo,
        to: [ctx.to], // fixed by code from the thread, never from the model or the client
        subject: b.subject ?? ctx.subject,
        bodyText: b.body,
      });
      await request.withWorkspace(async (tx) => {
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "followup.draft_saved",
            entityType: "commitment",
            entityId: ctx.commitment.id,
            after: { draftId: ref.draftId, threadId: ref.threadId, to: ctx.to },
          },
        );
        if (b.proposalId)
          await resolveFollowupProposal(
            tx,
            session.workspaceId,
            b.proposalId,
            ctx.commitment.id,
            "draft_saved",
            now,
          );
      });
      return reply.status(201).send({ draftId: ref.draftId, threadId: ref.threadId, to: ctx.to });
    },
  );

  r.post(
    "/v1/commitments/:id/remind",
    {
      preHandler: requireSession,
      schema: {
        tags: ["commitments"],
        params: IdParams,
        body: z
          .object({
            at: z.string().datetime({ offset: true }).optional(),
            proposalId: z.string().uuid().optional(),
          })
          .optional(),
        response: { 201: z.object({ task: TaskViewSchema }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.deps.now();
      const task = await request.withWorkspace(async (tx) => {
        const commitment = await getCommitment(tx, session.workspaceId, request.params.id);
        if (!commitment) throw new ApiError("NOT_FOUND", "Commitment not found.");
        const at = request.body?.at ? new Date(request.body.at) : new Date(now.getTime() + 86_400_000);
        const created = await createTask(
          tx,
          session.workspaceId,
          {
            title: `Seguimiento: ${commitment.action}`,
            clientId: commitment.clientId,
            dueAt: at.toISOString(),
            kind: "shallow",
            estimateMinutes: 15,
            priority: 2,
            deadlineType: "soft",
            status: "pending",
            tags: ["seguimiento"],
            origin: "user",
            sourceCommitmentId: commitment.id,
          },
          now,
        );
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "followup.reminder",
            entityType: "commitment",
            entityId: commitment.id,
            after: { taskId: created.id, at: at.toISOString() },
          },
        );
        if (request.body?.proposalId)
          await resolveFollowupProposal(
            tx,
            session.workspaceId,
            request.body.proposalId,
            commitment.id,
            "reminder",
            now,
          );
        return created;
      });
      if (options.onTasksChanged) await options.onTasksChanged(session.workspaceId, request.id);
      return reply.status(201).send({ task: serializeTask(task) });
    },
  );

  r.get(
    "/v1/ai/usage",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        response: {
          200: z.object({
            period: z.string(),
            usedUsd: z.number(),
            capUsd: z.number(),
            paused: z.boolean(),
            reason: z.enum(["access_inactive", "credits_exhausted", "cost_cap"]).nullable(),
            mode: z.enum(["fake", "live"]),
            credits: z.object({ allowance: z.number(), used: z.number(), remaining: z.number(), ratio: z.number() }),
            access: z.object({ active: z.boolean(), reason: z.string(), trialDaysLeft: z.number().int().nullable() }),
          }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.deps.now();
      const status = await request.withWorkspace((tx) =>
        aiStatus(tx, session.workspaceId, { now, aiMode: options.ai.mode, costCapUsd: options.costCapUsd }),
      );
      return {
        period: status.period,
        usedUsd: Math.round(status.costMicroUsd / 10_000) / 100,
        capUsd: options.costCapUsd,
        paused: status.paused,
        reason: status.reason,
        mode: options.ai.mode,
        credits: {
          allowance: status.balance.allowance,
          used: status.balance.used,
          remaining: status.balance.remaining,
          // Capped so JSON never carries Infinity (no allowance but some usage).
          ratio: Math.min(10, Math.round(status.balance.ratio * 1000) / 1000),
        },
        access: status.access,
      };
    },
  );

  done();
}
