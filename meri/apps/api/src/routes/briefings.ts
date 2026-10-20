/**
 * F-11 / AI-4 (D-043, ADR 0005): briefing of a client (or of a meeting with that client). The context is the
 * ContextBuilder's and nothing else; every item cites a source; the stored briefing is reused while the context
 * hash is unchanged (zero AI calls, zero writes); the live model has an 8 s budget and the rules are the fallback.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { generateBriefing } from "@meri/ai";
import type { FeatureFlagStore } from "@meri/config";
import { buildClientContext, gmailThreadUrl, localDateKey, type ClientContext } from "@meri/core";
import {
  audit,
  getBriefing,
  getCalendarEvent,
  getClient,
  getPreferences,
  loadClientSnapshot,
  upsertBriefing,
  type BriefingItemRow,
} from "@meri/db";
import { aiBudget, chargeAiUsage, notifyAiPaused } from "@meri/jobs";
import type { AiClient } from "@meri/integrations";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const IdParams = z.object({ id: z.string().uuid() });
const BriefingItemJson = z.object({
  claim: z.string(),
  kind: z.enum(["pending", "commitment", "communication", "decision", "risk"]),
  sourceType: z.enum(["task", "commitment", "thread", "event"]),
  sourceId: z.string(),
  sourceTitle: z.string().nullable(),
  url: z.string().nullable(),
});
export const BriefingJson = z.object({
  clientId: z.string(),
  clientName: z.string(),
  eventId: z.string().nullable(),
  source: z.enum(["rules", "ai"]),
  generatedAt: z.string().datetime(),
  reused: z.boolean(),
  items: z.array(BriefingItemJson),
});

export interface BriefingRoutesOptions {
  now: () => Date;
  ai: AiClient;
  flags: FeatureFlagStore;
  costCapUsd: number;
}

/** Source links are built by code from ids (never from the model): in-app anchors or the Gmail deep link. */
export function sourceUrl(item: { sourceType: string; sourceId: string }, ctx: ClientContext, timezone: string) {
  const src = ctx.items.find((i) => i.id === item.sourceId);
  switch (item.sourceType) {
    case "thread": {
      const ext = src?.facts["externalThreadId"];
      return typeof ext === "string" ? gmailThreadUrl(ext) : null;
    }
    case "task":
      return `/proyectos?tab=tareas&clientId=${encodeURIComponent(ctx.clientId)}#task-${item.sourceId}`;
    case "commitment":
      return `/proyectos?tab=compromisos&clientId=${encodeURIComponent(ctx.clientId)}#commitment-${item.sourceId}`;
    case "event":
      return src?.date ? `/calendario?date=${localDateKey(Date.parse(src.date), timezone)}` : "/calendario";
    default:
      return null;
  }
}

export function briefingRoutes(app: FastifyInstance, options: BriefingRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const serialize = (
    view: { clientId: string; eventId: string | null; source: string; generatedAt: Date; items: BriefingItemRow[] },
    clientName: string,
    reused: boolean,
  ) => ({
    clientId: view.clientId,
    clientName,
    eventId: view.eventId,
    source: view.source === "ai" ? ("ai" as const) : ("rules" as const),
    generatedAt: view.generatedAt.toISOString(),
    reused,
    items: view.items.map((i) => ({
      claim: i.claim,
      kind: i.kind as z.infer<typeof BriefingItemJson>["kind"],
      sourceType: i.sourceType as z.infer<typeof BriefingItemJson>["sourceType"],
      sourceId: i.sourceId,
      sourceTitle: i.sourceTitle ?? null,
      url: i.url ?? null,
    })),
  });

  r.get(
    "/v1/clients/:id/briefing",
    {
      preHandler: requireSession,
      schema: {
        tags: ["clients"],
        params: IdParams,
        querystring: z.object({ eventId: z.string().uuid().optional() }),
        response: { 200: BriefingJson.nullable() },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      return request.withWorkspace(async (tx) => {
        const client = await getClient(tx, session.workspaceId, request.params.id);
        if (!client) throw new ApiError("NOT_FOUND", "Client not found.");
        if (request.query.eventId) {
          const event = await getCalendarEvent(tx, session.workspaceId, request.query.eventId);
          if (!event || event.clientId !== client.id)
            throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
              { path: "eventId", message: "The event does not belong to this client." },
            ]);
        }
        const view = await getBriefing(tx, session.workspaceId, client.id, request.query.eventId ?? null);
        return view ? serialize(view, client.name, true) : null;
      });
    },
  );

  r.post(
    "/v1/clients/:id/briefing",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["clients"],
        params: IdParams,
        body: z.object({ eventId: z.string().uuid().optional() }).optional(),
        response: { 200: BriefingJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const eventId = request.body?.eventId ?? null;
      // 1. Context (isolated by construction) and cache check: same hash → reuse, no AI, no writes.
      const prepared = await request.withWorkspace(async (tx) => {
        const client = await getClient(tx, session.workspaceId, request.params.id);
        if (!client) throw new ApiError("NOT_FOUND", "Client not found.");
        if (eventId) {
          const event = await getCalendarEvent(tx, session.workspaceId, eventId);
          if (!event || event.clientId !== client.id)
            throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
              { path: "eventId", message: "The event does not belong to this client." },
            ]);
        }
        const snapshot = await loadClientSnapshot(tx, session.workspaceId, client.id, now);
        const ctx = buildClientContext(snapshot, client.id, { now: now.toISOString() });
        if (!ctx) throw new ApiError("NOT_FOUND", "Client not found.");
        const stored = await getBriefing(tx, session.workspaceId, client.id, eventId);
        const timezone = (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC";
        return { client, ctx, stored, timezone };
      });
      if (prepared.stored && prepared.stored.sourceHash === prepared.ctx.hash)
        return serialize(prepared.stored, prepared.client.name, true);
      // 2. Generate outside the transaction (the model call may take up to 8 s). Budget only for a real generation.
      const flagged = await options.flags.isEnabled("ai_briefings", session.workspaceId);
      const budget = flagged
        ? await request.withWorkspace((tx) =>
            aiBudget(tx, session.workspaceId, "brief_client", {
              now,
              aiMode: options.ai.mode,
              costCapUsd: options.costCapUsd,
            }),
          )
        : null;
      const useAi = flagged && budget?.allow === true;
      const result = await generateBriefing(options.ai, prepared.ctx, { now: now.toISOString(), useAi });
      const items: BriefingItemRow[] = result.items.map((i) => ({
        ...i,
        sourceTitle: prepared.ctx.items.find((x) => x.id === i.sourceId)?.title,
        url: sourceUrl(i, prepared.ctx, prepared.timezone) ?? undefined,
      }));
      // 3. Persist + audit (actor user: the briefing only exists because the user asked for it).
      const view = await request.withWorkspace(async (tx) => {
        if (result.usage) await chargeAiUsage(tx, session.workspaceId, "brief_client", [result.usage], { now });
        if (budget?.reason) await notifyAiPaused(tx, session.workspaceId, budget.reason, now);
        const saved = await upsertBriefing(
          tx,
          session.workspaceId,
          { clientId: prepared.client.id, eventId, items, sourceHash: prepared.ctx.hash, source: result.source },
          now,
        );
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "briefing.generated",
            entityType: "client",
            entityId: prepared.client.id,
            after: { eventId, source: result.source, items: items.length, sourceIds: items.map((i) => i.sourceId) },
          },
        );
        return saved;
      });
      return serialize(view, prepared.client.name, false);
    },
  );

  done();
}
