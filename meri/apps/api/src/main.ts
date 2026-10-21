import { createLogger, loadConfig, loadDotenv } from "@meri/config";
import { DbFlagStore, assertAppRole, createDb } from "@meri/db";
import { createIntegrations, FakeAiClient } from "@meri/integrations";
import { registerFakeAiHandlers } from "@meri/ai";
import { Redis } from "ioredis";
import { createDispatcher, enqueueReplan, enqueueTimeInfer } from "@meri/jobs";
import { buildApp } from "./app";

loadDotenv(".env");
loadDotenv("../../.env");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({
    name: "api",
    level: config.env.LOG_LEVEL,
    pretty: !config.isProduction && process.stdout.isTTY,
  });
  if (config.fakesOnProductionBuild)
    logger.warn(
      "fake adapters on a production build (ALLOW_FAKES_ON_PRODUCTION_BUILD=1): never use this in a deployment",
    );
  const now = config.env.DEMO_NOW ? () => new Date(config.env.DEMO_NOW ?? 0) : () => new Date();
  const handle = createDb(config.env.DATABASE_URL);
  await assertAppRole(handle.db);
  const integrations = createIntegrations(config, {
    now,
    onBackgroundError: (err) => {
      logger.warn({ err }, "analytics delivery failed");
    },
  });
  if (integrations.ai instanceof FakeAiClient) registerFakeAiHandlers(integrations.ai);
  const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: null });
  // Rate limit counters fail fast: a Redis outage must not stall requests (skipOnError lets them through).
  const rateLimitRedis = new Redis(config.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
  const dispatcher = createDispatcher(redis);
  const app = await buildApp({
    config,
    db: handle.db,
    integrations,
    logger,
    now,
    dispatcher,
    rateLimitMax: config.env.RATE_LIMIT_PER_MINUTE,
    rateLimitRedis,
    // Flags live in `feature_flags` (read-only for the app role; `pnpm flags:set` changes them).
    flags: new DbFlagStore(handle.db),
    onTasksChanged: async (workspaceId, traceId) => {
      await enqueueReplan(dispatcher, now, { workspaceId, traceId, reason: "tasks_changed" });
      // Completed blocks are a time source (D-042); the job is idempotent and debounced.
      await enqueueTimeInfer(dispatcher, { workspaceId, traceId, reason: "block_completed" });
    },
  });
  const port = config.env.PORT ?? 4000;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await dispatcher.close();
    redis.disconnect();
    rateLimitRedis.disconnect();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ port, host: config.env.LISTEN_HOST });
}

main().catch((err: unknown) => {
  // Startup failures (e.g. ConfigError) must be loud and cite the variable + guide (docs/blockers/README.md).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
