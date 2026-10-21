import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import {
  createObservability,
  InMemoryFlagStore,
  type AppConfig,
  type FeatureFlagStore,
  type Logger,
  type Observability,
} from "@meri/config";
import type { Db } from "@meri/db";
import type { Integrations } from "@meri/integrations";
import { enqueueTimeInfer, type JobDispatcher } from "@meri/jobs";
import { createErrorHandler, problemFrom, sendProblem } from "./errors";
import { contextPlugin } from "./plugins/context";
import { csrfPlugin } from "./plugins/csrf";
import { authGatePlugin } from "./plugins/auth-gate";
import { sessionPlugin } from "./plugins/session";
import { accountGuardPlugin } from "./plugins/account-guard";
import { accountRoutes } from "./routes/account";
import { accountSessionRoutes } from "./routes/account-sessions";
import { accountExportRoutes } from "./routes/export/route";
import { healthRoutes } from "./routes/health";
import { internalRoutes } from "./routes/internal";
import { betaRoutes } from "./routes/beta";
import { surveyRoutes } from "./routes/surveys";
import { taskRoutes } from "./routes/tasks";
import { captureRoutes } from "./routes/capture";
import { proposalRoutes } from "./routes/proposals";
import { integrationRoutes } from "./routes/integrations";
import { integrationOAuthRoutes } from "./routes/integrations-oauth";
import { deriveStateKey } from "./plugins/oauth-state";
import { idempotencyPlugin } from "./plugins/idempotency";
import { planRoutes } from "./routes/plan";
import { notificationRoutes } from "./routes/notifications";
import { mailRoutes } from "./routes/integrations-mail";
import { commitmentRoutes } from "./routes/commitments";
import { contactRoutes } from "./routes/contacts";
import { clientRoutes } from "./routes/clients";
import { briefingRoutes } from "./routes/briefings";
import { timeRoutes } from "./routes/time-entries";
import { searchRoutes } from "./routes/search";
import { agreementRoutes } from "./routes/agreements";
import { billingRoutes } from "./routes/billing";
import { valueReportRoutes } from "./routes/value-report";
import { reviewRoutes } from "./routes/reviews";
import { stripeWebhookRoutes } from "./routes/webhooks-stripe";
import { clientCapacity } from "./plugins/entitlements";

export interface AppDeps {
  config: AppConfig;
  db: Db;
  integrations: Integrations;
  logger: Logger;
  /** Injected clock (docs/12 §1). */
  now: () => Date;
  /** Override for tests. */
  rateLimitMax?: number;
  /**
   * Shared rate-limit store (ADR 0007): its own connection, never BullMQ's (that one retries forever). Without it
   * (tests) the limiter keeps per-process counters.
   */
  rateLimitRedis?: Redis;
  observability?: Observability;
  flags?: FeatureFlagStore;
  dispatcher: JobDispatcher;
  /** Hook for the replan trigger (set by main.ts to enqueue planner.replan). */
  onTasksChanged?: (workspaceId: string, traceId: string) => Promise<void>;
}

export const BODY_LIMIT_BYTES = 256 * 1024;

declare module "fastify" {
  interface FastifyInstance {
    routeTable: readonly { method: string; url: string }[];
  }
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(deps: AppDeps) {
  const { config } = deps;
  const trustedHops = config.env.TRUST_PROXY_HOPS;
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    // Trusted reverse-proxy hops (TRUST_PROXY_HOPS); never "trust everything", so X-Forwarded-For cannot be spoofed.
    trustProxy: trustedHops === 0 ? false : (_address: string, hop: number) => hop < trustedHops,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "traceId",
    genReqId: () => randomUUID(),
    disableRequestLogging: config.isTest,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Every registered route, for the authorization matrix (P5-06): a route missing from the matrix fails the test.
  const routeTable: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) if (method !== "HEAD") routeTable.push({ method, url: route.url });
  });
  app.decorate("routeTable", routeTable);
  const observability =
    deps.observability ??
    createObservability({
      service: "api",
      logger: deps.logger,
      sentryDsn: config.env.SENTRY_DSN,
      otelEndpoint: config.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
  app.setErrorHandler(createErrorHandler(observability.errors));
  app.addHook("onClose", async () => {
    // Buffered product events leave before the process does ([M9]).
    await deps.integrations.analytics.flush();
    await observability.shutdown();
  });
  app.setNotFoundHandler((request, reply) => sendProblem(reply, problemFrom("NOT_FOUND", request.id)));
  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-request-id", request.id);
    // Personal data never sits in a shared cache (D-081); routes may still set a stricter policy.
    if (request.session && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    done(null, payload);
  });

  await app.register(helmet, {
    // The API only serves JSON (and CSV/ZIP downloads): nothing may execute or frame it (D-081).
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimitMax ?? 300,
    timeWindow: "1 minute",
    ...(deps.rateLimitRedis
      ? {
          redis: deps.rateLimitRedis,
          nameSpace: "meri-rl:",
          // Availability over limiting when Redis is down (documented in docs/runbooks/provider-outage.md).
          skipOnError: true,
        }
      : {}),
    // Keyed by user when authenticated, by IP otherwise (docs/12 §3).
    keyGenerator: (request) => (request.session ? `u:${request.session.userId}` : `ip:${request.ip}`),
    // Internal routes are secret-authenticated server-to-server calls: every login from the web server would
    // otherwise share one IP bucket. Health endpoints are probed by orchestrators.
    allowList: (request) =>
      request.url === "/health" || request.url === "/ready" || request.url.startsWith("/internal/"),
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Meri API", version: "0.1.0", description: "Contract: docs/13-api-contract.md" },
      servers: [{ url: config.env.API_URL }],
      components: {
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: "authjs.session-token" } },
      },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(sessionPlugin, { secret: config.env.AUTH_SECRET, secure: config.isProduction });
  await app.register(accountGuardPlugin, { db: deps.db });
  await app.register(authGatePlugin);
  await app.register(csrfPlugin, { allowedOrigins: [config.env.APP_URL, config.env.API_URL] });
  await app.register(contextPlugin, { db: deps.db });
  await app.register(idempotencyPlugin, { now: deps.now });

  await app.register(healthRoutes, { db: deps.db });
  await app.register(internalRoutes, {
    db: deps.db,
    secret: config.env.INTERNAL_API_SECRET,
    now: deps.now,
    analytics: deps.integrations.analytics,
    betaInviteRequired: config.env.BETA_INVITE_REQUIRED,
  });
  await app.register(betaRoutes, { db: deps.db, now: deps.now });
  await app.register(surveyRoutes, { now: deps.now });
  await app.register(accountSessionRoutes, { db: deps.db });
  await app.register(accountExportRoutes, { db: deps.db, now: deps.now });
  await app.register(accountRoutes, {
    db: deps.db,
    now: deps.now,
    oauth: deps.integrations.oauth,
    keys: deps.integrations.kms.keys,
    demoMode: config.env.DEMO_MODE,
    billing: deps.integrations.billing,
    analytics: deps.integrations.analytics,
  });
  await app.register(taskRoutes, { now: deps.now, onTasksChanged: deps.onTasksChanged });
  const integrationOptions = {
    now: deps.now,
    db: deps.db,
    oauth: deps.integrations.oauth,
    keys: deps.integrations.kms.keys,
    dispatcher: deps.dispatcher,
    apiUrl: config.env.API_URL,
    appUrl: config.env.APP_URL,
    secureCookies: config.isProduction,
    calendarChannelToken: config.env.GOOGLE_CALENDAR_CHANNEL_TOKEN,
    // Push channels are not created in `live` yet (ADR 0008): polling only, so the webhooks stay closed.
    googlePush: config.modes.google === "fake",
    analytics: deps.integrations.analytics,
  };
  await app.register(integrationRoutes, integrationOptions);
  await app.register(integrationOAuthRoutes, {
    ...integrationOptions,
    stateKey: deriveStateKey(config.env.AUTH_SECRET),
  });
  await app.register(captureRoutes, {
    now: deps.now,
    ai: deps.integrations.ai,
    flags: deps.flags ?? new InMemoryFlagStore(),
    costCapUsd: config.env.AI_MONTHLY_COST_CAP_USD_PER_USER,
    analytics: deps.integrations.analytics,
  });
  await app.register(proposalRoutes, {
    now: deps.now,
    analytics: deps.integrations.analytics,
    maxClientsFor: (tx, workspaceId) => clientCapacity(tx, workspaceId, deps.now()),
    onTasksChanged: deps.onTasksChanged,
  });

  await app.register(planRoutes, {
    deps: {
      db: deps.db,
      integrations: deps.integrations,
      keys: deps.integrations.kms.keys,
      logger: deps.logger,
      now: deps.now,
    },
    onTasksChanged: deps.onTasksChanged,
  });

  await app.register(notificationRoutes, { now: deps.now });
  await app.register(commitmentRoutes, {
    deps: { db: deps.db, integrations: deps.integrations, keys: deps.integrations.kms.keys, now: deps.now },
    ai: deps.integrations.ai,
    costCapUsd: config.env.AI_MONTHLY_COST_CAP_USD_PER_USER,
    onTasksChanged: deps.onTasksChanged,
  });
  await app.register(contactRoutes, { now: deps.now });
  await app.register(clientRoutes, {
    now: deps.now,
    maxClientsFor: (tx, workspaceId) => clientCapacity(tx, workspaceId, deps.now()),
    onEventsLinked: (workspaceId, traceId) =>
      enqueueTimeInfer(deps.dispatcher, { workspaceId, traceId, reason: "event_assigned" }).then(
        () => undefined,
      ),
  });
  await app.register(timeRoutes, { now: deps.now, analytics: deps.integrations.analytics });
  await app.register(searchRoutes, {});
  await app.register(agreementRoutes, { now: deps.now });
  await app.register(briefingRoutes, {
    now: deps.now,
    ai: deps.integrations.ai,
    flags: deps.flags ?? new InMemoryFlagStore(),
    costCapUsd: config.env.AI_MONTHLY_COST_CAP_USD_PER_USER,
  });
  await app.register(mailRoutes, {
    now: deps.now,
    dispatcher: deps.dispatcher,
    channelToken: config.env.GOOGLE_CALENDAR_CHANNEL_TOKEN,
    googlePush: config.modes.google === "fake",
  });

  await app.register(billingRoutes, {
    db: deps.db,
    billing: deps.integrations.billing,
    analytics: deps.integrations.analytics,
    logger: deps.logger,
    now: deps.now,
    appUrl: config.env.APP_URL,
    allowFakeCompletion: deps.integrations.billing.mode === "fake" && !config.isProduction,
  });
  await app.register(valueReportRoutes, { now: deps.now, analytics: deps.integrations.analytics });
  await app.register(reviewRoutes, { now: deps.now });
  await app.register(stripeWebhookRoutes, {
    db: deps.db,
    billing: deps.integrations.billing,
    analytics: deps.integrations.analytics,
    logger: deps.logger,
    now: deps.now,
  });

  app.get("/docs/json", { schema: { hide: true } }, () => app.swagger());

  await app.ready();
  return app;
}
