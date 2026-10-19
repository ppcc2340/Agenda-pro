import Fastify from "fastify";
import type { Logger } from "@meri/config";
import type { QueueRegistry } from "./registry";

/** Minimal health panel for the worker: queue counts and dead-letter size (docs/12 §9). */
export async function buildHealthServer(registry: QueueRegistry, logger: Logger) {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });
  app.get("/health", () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready", ...(await registry.health()) }));
  await app.ready();
  return app;
}
