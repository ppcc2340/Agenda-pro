import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { suggestCapture } from "@meri/ai";
import { getVerticalTemplate } from "@meri/core";
import type { FeatureFlagStore } from "@meri/config";
import { audit, createProposal, getPreferences, listClients, type ProposalView } from "@meri/db";
import type { AiClient } from "@meri/integrations";
import { requireSession, sessionOf } from "../plugins/session";

export const ProposalViewSchema = z.object({
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
export const serializeProposal = (p: ProposalView) => ({
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
  /** D-045: hard when the vertical vocabulary names a dated deadline ("audiencia el 3 de noviembre"). */
  deadlineType: z.enum(["hard", "soft"]).nullable().default(null),
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
  /** Mail-sourced commitments carry their thread; event-sourced ones (D-044) carry `eventId` instead. */
  threadId: z.string().nullable().default(null),
  externalThreadId: z.string().nullable().default(null),
  subject: z.string().nullable(),
  externalMessageId: z.string().nullable().default(null),
  eventId: z.string().nullable().default(null),
});
export type CommitmentPayload = z.infer<typeof CommitmentPayload>;

export const CommitmentEdits = z.object({
  action: z.string().trim().min(3).max(300).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  /** owed_to_me only: also create a "waiting for" task that the planner keeps out of the day (F-08). */
  createWaitingTask: z.boolean().optional(),
});

export interface CaptureRoutesOptions {
  now: () => Date;
  ai: AiClient;
  flags: FeatureFlagStore;
}

export function captureRoutes(app: FastifyInstance, options: CaptureRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
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
      const { clients, prefs } = await request.withWorkspace(async (tx) => ({
        clients: await listClients(tx, session.workspaceId),
        prefs: await getPreferences(tx, session.workspaceId),
      }));
      const useAi = await options.flags.isEnabled("ai_capture", session.workspaceId);
      const { suggestion, source } = await suggestCapture(
        request.body.text,
        {
          now: now.toISOString(),
          timezone: prefs?.timezone ?? "UTC",
          clients,
          vocabulary: getVerticalTemplate(prefs?.vertical).vocabulary,
        },
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

  done();
}
