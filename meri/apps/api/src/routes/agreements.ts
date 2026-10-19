/**
 * D-044 post-meeting agreements (P3-06): free lines typed after a meeting become proposals (never confirmed items).
 * Lines that read as a commitment ("enviaré…", "nos envían…") become `commitment` proposals bound to the event
 * (no mail thread, hash on the event); the rest become `capture` proposals. Everything lands in Entrada.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { extractCommitmentsByRules, getVerticalTemplate, normalizeForMatch, parseCapture } from "@meri/core";
import {
  audit,
  createCommitment,
  createProposalIfAbsent,
  getCalendarEvent,
  getPreferences,
  listClients,
  listContacts,
  listIntegrationAccounts,
  type ProposalView,
} from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";
import { ProposalViewSchema, serializeProposal, type CapturePayload, type CommitmentPayload } from "./capture";

const IdParams = z.object({ id: z.string().uuid() });

export const eventCommitmentHash = (eventId: string, direction: string, action: string) =>
  createHash("sha256").update(`event:${eventId}:${direction}:${normalizeForMatch(action)}`).digest("hex");

export interface AgreementRoutesOptions {
  now: () => Date;
}

export function agreementRoutes(app: FastifyInstance, options: AgreementRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/events/:id/agreements",
    {
      preHandler: requireSession,
      schema: {
        tags: ["calendar"],
        params: IdParams,
        body: z.object({ lines: z.array(z.string().trim().min(3).max(300)).min(1).max(20) }),
        response: { 201: z.object({ proposals: z.array(ProposalViewSchema), skipped: z.number().int() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const result = await request.withWorkspace(async (tx) => {
        const event = await getCalendarEvent(tx, session.workspaceId, request.params.id);
        if (!event || event.origin !== "external") throw new ApiError("NOT_FOUND", "Event not found.");
        const [prefs, clients, contacts, accounts] = await Promise.all([
          getPreferences(tx, session.workspaceId),
          listClients(tx, session.workspaceId),
          listContacts(tx, session.workspaceId),
          listIntegrationAccounts(tx, session.workspaceId),
        ]);
        const timezone = prefs?.timezone ?? "UTC";
        const me = accounts.find((a) => a.email)?.email ?? "me@meri.local";
        const client = clients.find((c) => c.id === event.clientId) ?? null;
        // Counterparty = first attendee that belongs to the client (code, never the model), else none.
        const mine = me.toLowerCase();
        const counterparty =
          event.attendees
            .map((a) => a.toLowerCase())
            .find((a) => a !== mine && client?.domains.some((d) => a.endsWith(`@${d}`) || a.endsWith(`.${d}`))) ??
          event.attendees.map((a) => a.toLowerCase()).find((a) => a !== mine) ??
          null;
        const counterpartyName = counterparty ? (contacts.find((c) => c.email === counterparty)?.name ?? null) : null;
        const sourceRef = { type: "event", id: event.id };
        const proposals: ProposalView[] = [];
        let skipped = 0;
        for (const line of request.body.lines) {
          // A synthetic "message from me to the counterparty": first-person promises are owed by me, requests
          // ("que nos envíen…") are owed to me, exactly as the mail rules read them (D-044).
          const found = extractCommitmentsByRules(
            { id: event.id, from: me, to: counterparty ? [counterparty] : [], date: now.toISOString(), text: line },
            { me, timezone, now: now.toISOString() },
          );
          const c = found[0];
          if (c) {
            const dedupeHash = eventCommitmentHash(event.id, c.direction, c.action);
            const commitment = await createCommitment(
              tx,
              session.workspaceId,
              {
                clientId: event.clientId,
                direction: c.direction,
                kind: c.kind,
                status: "proposed",
                counterpartyEmail: counterparty,
                action: c.action,
                dueAt: c.dueAt ? new Date(c.dueAt) : null,
                dueText: c.dueText,
                confidence: c.confidence,
                evidence: line.slice(0, 200),
                threadId: null,
                externalMessageId: null,
                dedupeHash,
                origin: "user",
              },
              now,
            );
            if (!commitment) {
              skipped++;
              continue;
            }
            const payload: CommitmentPayload = {
              commitmentId: commitment.id,
              direction: c.direction,
              action: c.action,
              dueAt: c.dueAt,
              dueText: c.dueText,
              kind: c.kind,
              confidence: c.confidence,
              evidence: line.slice(0, 200),
              counterpartyEmail: counterparty,
              counterpartyName,
              clientId: event.clientId,
              threadId: null,
              externalThreadId: null,
              subject: event.title,
              externalMessageId: null,
              eventId: event.id,
            };
            const created = await createProposalIfAbsent(
              tx,
              session.workspaceId,
              { kind: "commitment", payload: { ...payload }, confidence: c.confidence, explanation: "agreement", sourceRef, dedupeHash: `proposal:${dedupeHash}` },
              now,
            );
            if (created) proposals.push(created);
            else skipped++;
            continue;
          }
          const s = parseCapture(line, {
            now: now.toISOString(),
            timezone,
            clients,
            vocabulary: getVerticalTemplate(prefs?.vertical).vocabulary,
          });
          const payload: CapturePayload = {
            text: line,
            title: s.title,
            clientId: s.clientId ?? event.clientId,
            clientName: s.clientName ?? client?.name ?? null,
            dueAt: s.dueAt,
            dueText: s.dueText,
            estimateMinutes: s.estimateMinutes,
            priority: s.priority,
            kind: s.kind,
            deadlineType: s.deadlineType,
            source: "rules",
          };
          const created = await createProposalIfAbsent(
            tx,
            session.workspaceId,
            {
              kind: "capture",
              payload: { ...payload },
              confidence: s.confidence,
              explanation: "agreement",
              sourceRef,
              dedupeHash: `capture:event:${event.id}:${normalizeForMatch(line)}`,
            },
            now,
          );
          if (created) proposals.push(created);
          else skipped++;
        }
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "agreements.recorded",
            entityType: "calendar_event",
            entityId: event.id,
            after: { lines: request.body.lines.length, proposals: proposals.length, skipped },
          },
        );
        return { proposals, skipped };
      });
      return reply.status(201).send({ proposals: result.proposals.map(serializeProposal), skipped: result.skipped });
    },
  );

  done();
}
