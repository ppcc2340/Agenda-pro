import { createLogger, loadConfig, loadDotenv } from "@meri/config";
import { assertAppRole, createDb } from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { buildApp } from "./app";

loadDotenv(".env");
loadDotenv("../../.env");

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: "api", level: config.env.LOG_LEVEL, pretty: !config.isProduction });
  const now = config.env.DEMO_NOW ? () => new Date(config.env.DEMO_NOW ?? 0) : () => new Date();
  const handle = createDb(config.env.DATABASE_URL);
  await assertAppRole(handle.db);
  const integrations = createIntegrations(config, { now });
  const app = await buildApp({ config, db: handle.db, integrations, logger, now });
  const port = config.env.PORT ?? 4000;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  // Startup failures (e.g. ConfigError) must be loud and cite the variable + guide (docs/blockers/README.md).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
