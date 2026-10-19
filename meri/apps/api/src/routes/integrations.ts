import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { KeyProvider } from "@meri/config/crypto";
import {
  audit,
  deleteIntegrationAccount,
  getIntegrationAccount,
  listCalendarEvents,
  listIntegrationAccounts,
  setIntegrationStatus,
  upsertIntegrationAccount,
  type IntegrationAccountView,
} from "@meri/db";
import { hasCalendarScopes, hasGmailScopes, scopesFor, type GoogleOAuth } from "@meri/integrations";
import {
  CalendarSyncJob,
  GmailSyncJob,
  encryptTokens,
  purgeAccountMail,
  type JobDispatcher,
} from "@meri/jobs";
import { ApiError } from "../errors";
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

/** OAuth `state` cookie: short-lived, HttpOnly; verified on callback (docs/06 §7 redirect validation). */
const STATE_COOKIE = "meri.oauth.state";
const IdParams = z.object({ id: z.string().uuid() });

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface IntegrationRoutesOptions {
  now: () => Date;
  oauth: GoogleOAuth;
  keys: KeyProvider;
  dispatcher: JobDispatcher;
  apiUrl: string;
  appUrl: string;
  secureCookies: boolean;
  /** Token Google must send with calendar push notifications (X-Goog-Channel-Token). */
  calendarChannelToken: string;
}

export function integrationRoutes(
  app: FastifyInstance,
  options: IntegrationRoutesOptions,
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const redirectUri = `${options.apiUrl}/v1/integrations/google/callback`;

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
    "/v1/integrations/:provider/connect",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: z.object({ provider: z.literal("google") }),
        querystring: z.object({ feature: z.enum(["calendar", "gmail", "all"]).default("calendar") }),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const state = randomBytes(24).toString("base64url");
      reply.setCookie(STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: options.secureCookies,
        path: "/v1/integrations",
        maxAge: 600,
      });
      // Incremental authorization (ADR 0004 §1): only the scopes of the requested feature.
      const url = options.oauth.authorizationUrl({
        state,
        scopes: scopesFor(request.query.feature),
        redirectUri,
        loginHint: session.email,
      });
      return { url };
    },
  );

  r.get(
    "/v1/integrations/:provider/callback",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: z.object({ provider: z.literal("google") }),
        querystring: z.object({
          code: z.string().min(1).max(512).optional(),
          state: z.string().min(1).max(128),
          error: z.string().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const expected = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/v1/integrations" });
      if (!expected || expected !== request.query.state)
        throw new ApiError("FORBIDDEN", "OAuth state mismatch.");
      if (request.query.error || !request.query.code)
        return reply.redirect(`${options.appUrl}/control?integration=denied`);
      const tokens = await options.oauth.exchangeCode({ code: request.query.code, redirectUri });
      const now = options.now();
      const account = await request.withWorkspace(async (tx) => {
        // Two steps: the row id is part of the encryption AAD, so insert first, then store the ciphertext.
        const provisional = await upsertIntegrationAccount(
          tx,
          session.workspaceId,
          {
            provider: "google",
            externalAccountId: tokens.externalAccountId,
            email: tokens.email,
            scopes: tokens.scopes,
            encryptedTokens: "pending",
            keyId: options.keys.keyId,
          },
          now,
        );
        const blob = await encryptTokens({ keys: options.keys }, session.workspaceId, provisional.id, tokens);
        const stored = await setIntegrationStatus(tx, session.workspaceId, provisional.id, {
          encryptedTokens: blob,
          keyId: options.keys.keyId,
          status: "healthy",
          lastError: null,
        });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "integration.connected",
            entityType: "integration_account",
            entityId: provisional.id,
            after: { provider: "google", scopes: tokens.scopes },
          },
        );
        return stored ?? provisional;
      });
      const connectBucket = String(Math.floor(Date.now() / 5_000));
      if (hasCalendarScopes(account.scopes)) {
        await options.dispatcher.enqueue(
          CalendarSyncJob,
          {
            workspaceId: session.workspaceId,
            traceId: request.id,
            integrationAccountId: account.id,
            reason: "connect",
          },
          { jobId: `calendar.sync:${account.id}:connect:${connectBucket}` },
        );
      }
      if (hasGmailScopes(account.scopes)) {
        await options.dispatcher.enqueue(
          GmailSyncJob,
          {
            workspaceId: session.workspaceId,
            traceId: request.id,
            integrationAccountId: account.id,
            reason: "connect",
          },
          { jobId: `gmail.sync:${account.id}:connect:${connectBucket}` },
        );
      }
      return reply.redirect(`${options.appUrl}/control?integration=connected`);
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
        { jobId: `calendar.sync:${current.id}:${String(options.now().getTime())}` },
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
      return {
        items: items.map((e) => ({
          ...e,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
        })),
      };
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
            jobId: `calendar.sync:${parsed.data.accountId}:webhook:${String(Math.floor(Date.now() / 15_000))}`,
          },
        );
      }
      return reply.status(204).send(null);
    },
  );

  done();
}
