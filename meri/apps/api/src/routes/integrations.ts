import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { KeyProvider } from "@meri/config/crypto";
import {
  audit,
  deleteIntegrationAccount,
  getCalendarEvent,
  getClient,
  getIntegrationAccount,
  listCalendarEvents,
  setCalendarEventClient,
  listIntegrationAccounts,
  setIntegrationStatus,
  type Db,
  type IntegrationAccountView,
} from "@meri/db";
import type { Analytics, GoogleOAuth } from "@meri/integrations";
import {
  CalendarSyncJob,
  enqueueTimeInfer,
  purgeAccountMail,
  readTokens,
  type JobDispatcher,
} from "@meri/jobs";
import { ApiError } from "../errors";
import { safeEqual } from "../plugins/oauth-state";
import { requireSession, sessionOf } from "../plugins/session";

const AccountView = z.object({
  id: z.string(),
  provider: z.string(),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  status: z.enum(["healthy", "needs_reauth", "degraded", "paused", "revoked"]),
  lastSyncAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
});
const serializeAccount = (a: IntegrationAccountView) => ({
  id: a.id,
  provider: a.provider,
  email: a.email,
  scopes: a.scopes,
  status: a.status,
  lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
  lastError: a.lastError,
  createdAt: a.createdAt.toISOString(),
});

const EventView = z.object({
  id: z.string(),
  integrationAccountId: z.string().nullable(),
  externalId: z.string(),
  title: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean(),
  attendees: z.array(z.string()),
  clientId: z.string().nullable(),
  origin: z.enum(["meri", "external"]),
  busy: z.boolean(),
});

const IdParams = z.object({ id: z.string().uuid() });

export interface IntegrationRoutesOptions {
  now: () => Date;
  /** Owner of the token reads done outside a request transaction (revocation on disconnect). */
  db: Db;
  oauth: GoogleOAuth;
  keys: KeyProvider;
  dispatcher: JobDispatcher;
  apiUrl: string;
  appUrl: string;
  secureCookies: boolean;
  /** Token Google must send with calendar push notifications (X-Goog-Channel-Token). */
  calendarChannelToken: string;
  analytics: Analytics;
}

export function integrationRoutes(
  app: FastifyInstance,
  options: IntegrationRoutesOptions,
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/integrations",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], response: { 200: z.object({ items: z.array(AccountView) }) } },
    },
    async (request) => {
      const session = sessionOf(request);
      const items = await request.withWorkspace((tx) => listIntegrationAccounts(tx, session.workspaceId));
      return { items: items.map(serializeAccount) };
    },
  );

  r.post(
    "/v1/integrations/:id/pause",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], params: IdParams, response: { 200: AccountView } },
    },
    async (request) => {
      const session = sessionOf(request);
      const account = await request.withWorkspace(async (tx) => {
        const current = await getIntegrationAccount(tx, session.workspaceId, request.params.id);
        if (!current) throw new ApiError("NOT_FOUND", "Integration not found.");
        const next = current.status === "paused" ? "healthy" : "paused";
        const updated = await setIntegrationStatus(tx, session.workspaceId, current.id, { status: next });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: next === "paused" ? "integration.paused" : "integration.resumed",
            entityType: "integration_account",
            entityId: current.id,
            before: { status: current.status },
            after: { status: next },
          },
        );
        return updated ?? current;
      });
      return serializeAccount(account);
    },
  );

  r.delete(
    "/v1/integrations/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], params: IdParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      // docs/06 §1: revoking a connection also revokes its token at the provider (after commit, best effort).
      const tokens = await readTokens({ db: options.db, keys: options.keys }, session.workspaceId, request.params.id).catch(
        (err: unknown) => {
          request.log.warn({ err }, "tokens unreadable on disconnect; deleted without revocation");
          return null;
        },
      );
      await request.withWorkspace(async (tx) => {
        const current = await getIntegrationAccount(tx, session.workspaceId, request.params.id);
        if (!current) throw new ApiError("NOT_FOUND", "Integration not found.");
        // D-036 "desconectar y purgar": indexed mail, proposed commitments and pending mail proposals go with it.
        const purged = await purgeAccountMail(tx, session.workspaceId, current.id, options.now());
        await deleteIntegrationAccount(tx, session.workspaceId, current.id);
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "integration.disconnected",
            entityType: "integration_account",
            entityId: current.id,
            before: { provider: current.provider, email: current.email },
            after: { purged },
          },
        );
      });
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token)
        await options.oauth.revoke(token).catch((err: unknown) => {
          request.log.warn({ err }, "provider revocation failed on disconnect");
        });
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/v1/integrations/:id/sync",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: IdParams,
        response: { 202: z.object({ queued: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const current = await request.withWorkspace((tx) =>
        getIntegrationAccount(tx, session.workspaceId, request.params.id),
      );
      if (!current) throw new ApiError("NOT_FOUND", "Integration not found.");
      await options.dispatcher.enqueue(
        CalendarSyncJob,
        {
          workspaceId: session.workspaceId,
          traceId: request.id,
          integrationAccountId: current.id,
          reason: "manual",
        },
        { jobId: `calendar.sync_${current.id}_${String(options.now().getTime())}` },
      );
      return reply.status(202).send({ queued: true });
    },
  );

  r.get(
    "/v1/calendar/events",
    {
      preHandler: requireSession,
      schema: {
        tags: ["calendar"],
        querystring: z.object({
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
          clientId: z.string().uuid().optional(),
        }),
        response: { 200: z.object({ items: z.array(EventView) }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (to.getTime() - from.getTime() > 62 * 86_400_000 || to <= from)
        throw new ApiError("VALIDATION_FAILED", "Range must be positive and at most 62 days.");
      const items = await request.withWorkspace((tx) =>
        listCalendarEvents(tx, session.workspaceId, { from, to }),
      );
      const wanted = request.query.clientId;
      return {
        items: items
          .filter((e) => !wanted || e.clientId === wanted)
          .map((e) => ({
            ...e,
            startsAt: e.startsAt.toISOString(),
            endsAt: e.endsAt.toISOString(),
          })),
      };
    },
  );

  /** F-09: assign an external meeting to a client (ADR 0005); Meri blocks are never touched. Feeds time.infer. */
  r.patch(
    "/v1/calendar/events/:id",
    {
      preHandler: requireSession,
      schema: {
        tags: ["calendar"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ clientId: z.string().uuid().nullable() }),
        response: { 200: EventView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const updated = await request.withWorkspace(async (tx) => {
        const before = await getCalendarEvent(tx, session.workspaceId, request.params.id);
        if (!before || before.origin !== "external") throw new ApiError("NOT_FOUND", "Event not found.");
        if (request.body.clientId && !(await getClient(tx, session.workspaceId, request.body.clientId)))
          throw new ApiError("VALIDATION_FAILED", "Invalid references.", [{ path: "clientId", message: "Unknown client." }]);
        await setCalendarEventClient(tx, session.workspaceId, before.id, request.body.clientId);
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "event.client_assigned",
            entityType: "calendar_event",
            entityId: before.id,
            before: { clientId: before.clientId },
            after: { clientId: request.body.clientId },
          },
        );
        return getCalendarEvent(tx, session.workspaceId, before.id);
      });
      if (!updated) throw new ApiError("NOT_FOUND", "Event not found.");
      await enqueueTimeInfer(options.dispatcher, { workspaceId: session.workspaceId, traceId: request.id, reason: "event_assigned" });
      return { ...updated, startsAt: updated.startsAt.toISOString(), endsAt: updated.endsAt.toISOString() };
    },
  );

  /** Google Calendar push channel (docs/13): verify the channel token, then sync the account named by the channel id. */
  r.post(
    "/webhooks/google/calendar",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: { hide: true, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const token = request.headers["x-goog-channel-token"];
      const channelId = request.headers["x-goog-channel-id"];
      if (typeof token !== "string" || !safeEqual(token, options.calendarChannelToken))
        throw new ApiError("FORBIDDEN", "Invalid channel token.");
      // Channel id format: "<workspaceId>:<integrationAccountId>" (set when the watch is created, phase 1 polling fallback otherwise).
      const [workspaceId, accountId] = typeof channelId === "string" ? channelId.split(":") : [];
      const parsed = z
        .object({ workspaceId: z.string().uuid(), accountId: z.string().uuid() })
        .safeParse({ workspaceId, accountId });
      if (parsed.success) {
        await options.dispatcher.enqueue(
          CalendarSyncJob,
          {
            workspaceId: parsed.data.workspaceId,
            traceId: request.id,
            integrationAccountId: parsed.data.accountId,
            reason: "webhook",
          },
          // Bucketed id: pushes within 15 s collapse, later ones are never dropped by a retained completed job.
          {
            jobId: `calendar.sync_${parsed.data.accountId}_webhook_${String(Math.floor(Date.now() / 15_000))}`,
          },
        );
      }
      return reply.status(204).send(null);
    },
  );

  done();
}
