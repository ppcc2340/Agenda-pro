import { writeFileSync } from "node:fs";
import { createLogger, loadConfig, loadDotenv } from "@meri/config";
import { createDb } from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { buildApp } from "./app";

/** Writes openapi.json (published as a CI artifact; must match docs/13-api-contract.md). */
loadDotenv(".env");
loadDotenv("../../.env");
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const handle = createDb(config.env.DATABASE_URL, { max: 1 });
const app = await buildApp({
  config,
  db: handle.db,
  integrations: createIntegrations(config, { now: () => new Date() }),
  logger: createLogger({ name: "openapi", level: "silent" }),
  now: () => new Date(),
});
writeFileSync("openapi.json", JSON.stringify(app.swagger(), null, 2));
await app.close();
await handle.close();
console.warn("openapi.json written");
