import { Redis } from "ioredis";
import { createLogger, loadConfig, loadDotenv } from "@meri/config";
import { createDb } from "@meri/db";
import { buildHealthServer } from "./health";
import { examplePing } from "./queues/example";
import { QueueRegistry } from "./registry";

loadDotenv(".env");
loadDotenv("../../.env");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: "worker", level: config.env.LOG_LEVEL, pretty: !config.isProduction });
  const connection = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: null });
  const handle = createDb(config.env.DATABASE_URL, { max: 5 });
  const registry = new QueueRegistry({ connection, db: handle.db, logger });
  registry.register(examplePing);
  const health = await buildHealthServer(registry, logger);
  const port = config.env.PORT ?? 4100;
  await health.listen({ port, host: "0.0.0.0" });
  logger.info({ port, queues: ["example.ping"] }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    await health.close();
    await registry.close();
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
