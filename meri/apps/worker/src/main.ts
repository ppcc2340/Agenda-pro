import { Redis } from "ioredis";
import postgres from "postgres";
import { registerFakeAiHandlers } from "@meri/ai";
import { createLogger, loadConfig, loadDotenv } from "@meri/config";
import { assertAppRole, createDb } from "@meri/db";
import { createIntegrations, FakeAiClient } from "@meri/integrations";
import { createDispatcher } from "@meri/jobs";
import { dispatchCalendarPolling, schedule } from "./dispatchers";
import { buildHealthServer } from "./health";
import { calendarSyncJob } from "./queues/calendar-sync";
import { plannerReplanJob } from "./queues/planner-replan";
import { examplePing } from "./queues/example";
import { QueueRegistry } from "./registry";

loadDotenv(".env");
loadDotenv("../../.env");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: "worker", level: config.env.LOG_LEVEL, pretty: !config.isProduction });
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

  // Cross-tenant dispatchers (D-025) use the owner connection only to enumerate accounts.
  const adminSql = postgres(config.env.DATABASE_ADMIN_URL ?? config.env.DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  const stopPolling = schedule(
    "calendar.poll",
    5 * 60_000,
    () => dispatchCalendarPolling({ adminSql, dispatcher, logger, now }),
    logger,
  );

  const health = await buildHealthServer(registry, logger);
  const port = config.env.PORT ?? 4100;
  await health.listen({ port, host: "0.0.0.0" });
  logger.info({ port, queues: ["example.ping", "calendar.sync", "planner.replan"] }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    stopPolling();
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
