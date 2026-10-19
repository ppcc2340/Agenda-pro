import { Redis } from "ioredis";
import postgres from "postgres";
import { registerFakeAiHandlers } from "@meri/ai";
import { ConfigError, createLogger, loadConfig, loadDotenv } from "@meri/config";
import { assertAppRole, createDb } from "@meri/db";
import { createIntegrations, FakeAiClient } from "@meri/integrations";
import { createDispatcher } from "@meri/jobs";
import { dispatchCalendarPolling, dispatchDailyReview, dispatchMailPolling, schedule } from "./dispatchers";
import { buildHealthServer } from "./health";
import { calendarSyncJob } from "./queues/calendar-sync";
import { dailyReviewJob } from "./queues/daily-review";
import { gmailSyncJob } from "./queues/gmail-sync";
import { extractCommitmentsJob } from "./queues/extract-commitments";
import { plannerReplanJob } from "./queues/planner-replan";
import { examplePing } from "./queues/example";
import { QueueRegistry } from "./registry";

loadDotenv(".env");
loadDotenv("../../.env");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: "worker", level: config.env.LOG_LEVEL, pretty: !config.isProduction });
  if (config.fakesOnProductionBuild)
    logger.warn(
      "fake adapters on a production build (ALLOW_FAKES_ON_PRODUCTION_BUILD=1): never use this in a deployment",
    );
  const now = config.env.DEMO_NOW ? () => new Date(config.env.DEMO_NOW ?? 0) : () => new Date();
  const connection = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: null });
  const handle = createDb(config.env.DATABASE_URL, { max: 5 });
  await assertAppRole(handle.db);
  const integrations = createIntegrations(config, { now });
  if (integrations.ai instanceof FakeAiClient) registerFakeAiHandlers(integrations.ai);
  const registry = new QueueRegistry({ connection, db: handle.db, logger });
  registry.register(examplePing);
  const dispatcher = createDispatcher(connection);
  const handlerDeps = { db: handle.db, integrations, keys: integrations.kms.keys, now };
  registry.register(calendarSyncJob(handlerDeps, dispatcher));
  registry.register(plannerReplanJob(handlerDeps));
  registry.register(dailyReviewJob(handlerDeps));
  registry.register(gmailSyncJob(handlerDeps, dispatcher));
  registry.register(
    extractCommitmentsJob({ ...handlerDeps, costCapUsd: config.env.AI_MONTHLY_COST_CAP_USD_PER_USER }),
  );

  // Cross-tenant dispatchers (D-025) use the owner connection only to enumerate accounts.
  // Cross-tenant dispatchers need the owner connection: under the app role + forced RLS they would silently
  // enumerate nothing and no poll or digest would ever fire.
  if (!config.env.DATABASE_ADMIN_URL)
    throw new ConfigError("Invalid worker configuration", [
      "DATABASE_ADMIN_URL is required by the worker (cross-tenant dispatchers).",
    ]);
  const adminSql = postgres(config.env.DATABASE_ADMIN_URL, {
    max: 1,
    onnotice: () => {},
  });
  const stopPolling = schedule(
    "calendar.poll",
    5 * 60_000,
    () => dispatchCalendarPolling({ adminSql, dispatcher, logger, now }),
    logger,
  );

  const stopMailPolling = schedule(
    "gmail.poll",
    5 * 60_000,
    () => dispatchMailPolling({ adminSql, dispatcher, logger, now }),
    logger,
  );
  const stopDigest = schedule(
    "daily.review",
    15 * 60_000,
    () => dispatchDailyReview({ adminSql, dispatcher, logger, now }),
    logger,
  );

  const health = await buildHealthServer(registry, logger);
  const port = config.env.PORT ?? 4100;
  await health.listen({ port, host: "0.0.0.0" });
  logger.info(
    {
      port,
      queues: [
        "example.ping",
        "calendar.sync",
        "planner.replan",
        "daily.review",
        "gmail.sync",
        "ai.extract_commitments",
      ],
    },
    "worker started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    stopPolling();
    stopDigest();
    stopMailPolling();
    await health.close();
    await registry.close();
    await dispatcher.close();
    await adminSql.end({ timeout: 5 });
    await handle.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
