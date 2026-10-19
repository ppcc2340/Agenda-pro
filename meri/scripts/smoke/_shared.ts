/* Shared helpers for smoke tests: load config without printing secrets, build integrations, report. */
import { createIntegrations, type Integrations } from "@meri/integrations";
import { loadConfig, loadDotenv, type AppConfig } from "@meri/config";

export interface SmokeContext {
  config: AppConfig;
  integrations: Integrations;
  now: Date;
}

export function setup(): SmokeContext {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  const now = config.env.DEMO_NOW ? new Date(config.env.DEMO_NOW) : new Date();
  const integrations = createIntegrations(config, { now: () => now });
  return { config, integrations, now };
}

export function ok(step: string): void {
  console.warn(`  ✓ ${step}`);
}

export async function run(id: string, fn: (ctx: SmokeContext) => Promise<void>): Promise<void> {
  console.warn(`\nSmoke: ${id}`);
  try {
    const ctx = setup();
    await fn(ctx);
    console.warn(`PASS ${id}\n`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`FAIL ${id}: ${message}\n`);
    process.exit(1);
  }
}
