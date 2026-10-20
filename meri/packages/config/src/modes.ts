import type { Env } from "./env";
import { ConfigError } from "./env";
import blockersManifest from "../../../blockers.json";

export interface BlockerDefinition {
  id: string;
  title: string;
  critical: boolean;
  modeVar: string | null;
  modeValuesLive?: string[];
  env: string[];
  guide: string;
}

export const BLOCKERS: readonly BlockerDefinition[] = (blockersManifest as { blockers: BlockerDefinition[] })
  .blockers;

export type IntegrationId = "google" | "ai" | "stripe" | "analytics" | "kms";
export type ResolvedModes = Record<IntegrationId, "fake" | "live">;

const MODE_VAR_TO_INTEGRATION: Record<string, IntegrationId> = {
  GOOGLE_MODE: "google",
  AI_MODE: "ai",
  STRIPE_MODE: "stripe",
  ANALYTICS_MODE: "analytics",
  KMS_PROVIDER: "kms",
};

function isLive(def: BlockerDefinition, value: string | undefined): boolean {
  if (!def.modeVar) return false;
  if (def.modeValuesLive) return def.modeValuesLive.includes(value ?? "");
  return value === "live";
}

/**
 * Resolve fake/live per integration and enforce the rules of docs/blockers/README.md:
 *  - live without its credentials -> fail, citing the variable and the guide;
 *  - production forbids fake/noop and KMS_PROVIDER=local.
 */
/**
 * Production = APP_ENV when set, otherwise NODE_ENV (D-029). `staging` counts as production for the fake/KMS
 * prohibition: only `development`/`test` may run fakes, and on an optimized build (NODE_ENV=production) they also need
 * the explicit `ALLOW_FAKES_ON_PRODUCTION_BUILD=1`, so a stray APP_ENV can never de-harden a deployment silently.
 */
export const isProductionEnv = (env: Pick<Env, "NODE_ENV" | "APP_ENV">): boolean => {
  const app = env.APP_ENV ?? env.NODE_ENV;
  return app === "production" || app === "staging";
};

/** True when fakes run on an optimized build (dev/E2E/demo); apps log a loud warning at startup. */
export const fakesOnProductionBuild = (env: Pick<Env, "NODE_ENV" | "APP_ENV">): boolean =>
  env.NODE_ENV === "production" && !isProductionEnv(env);

export function resolveModes(env: Env, blockers: readonly BlockerDefinition[] = BLOCKERS): ResolvedModes {
  const raw = env as unknown as Record<string, unknown>;
  const errors: string[] = [];
  const modes: ResolvedModes = { google: "fake", ai: "fake", stripe: "fake", analytics: "fake", kms: "fake" };

  for (const def of blockers) {
    if (!def.modeVar) continue;
    const integration = MODE_VAR_TO_INTEGRATION[def.modeVar];
    if (!integration) continue;
    const value = raw[def.modeVar];
    const live = isLive(def, typeof value === "string" ? value : undefined);
    modes[integration] = live ? "live" : "fake";
    if (live) {
      const missing = def.env.filter((k) => {
        const v = raw[k];
        return typeof v !== "string" || v.trim() === "";
      });
      if (missing.length > 0) {
        errors.push(
          `${def.modeVar}=${String(value)} requires ${missing.join(", ")}. See ${def.guide} or set ${def.modeVar} back to its fake value.`,
        );
      }
    } else if (isProductionEnv(env)) {
      errors.push(`${def.modeVar}=${String(value)} is forbidden in production. See ${def.guide}.`);
    }
  }

  if (fakesOnProductionBuild(env) && env.ALLOW_FAKES_ON_PRODUCTION_BUILD !== "1") {
    errors.push(
      `APP_ENV=${String(env.APP_ENV)} on a production build (NODE_ENV=production) requires ALLOW_FAKES_ON_PRODUCTION_BUILD=1 (never in a real deployment; see docs/blockers/README.md).`,
    );
  }
  // DEMO_MODE signs in without credentials (PROTOTYPE.md, D-049): never on a production configuration.
  if (env.DEMO_MODE && isProductionEnv(env))
    errors.push("DEMO_MODE=1 is forbidden in production: the demo signs in as demo@meri.local without credentials.");
  if (isProductionEnv(env)) {
    const placeholders = (["AUTH_SECRET", "INTERNAL_API_SECRET"] as const).filter((k) =>
      /^change-me/i.test(env[k]),
    );
    if (/^dev-/.test(env.GOOGLE_CALENDAR_CHANNEL_TOKEN) || env.GOOGLE_CALENDAR_CHANNEL_TOKEN.length < 16)
      errors.push(
        "GOOGLE_CALENDAR_CHANNEL_TOKEN must be a random secret of at least 16 characters in production.",
      );
    if (placeholders.length > 0)
      errors.push(`${placeholders.join(", ")} still hold the .env.example placeholder; set real secrets.`);
    if (!env.AUTH_URL)
      errors.push(
        "AUTH_URL is required in production (Auth.js must not derive callbacks from the Host header).",
      );
  }

  if (env.KMS_PROVIDER === "gcp")
    errors.push("KMS_PROVIDER=gcp is not available yet (ADR 0007 chose AWS KMS). See docs/blockers/kms.md.");
  if (env.KMS_PROVIDER === "local" && !env.LOCAL_MASTER_KEY) {
    errors.push("KMS_PROVIDER=local requires LOCAL_MASTER_KEY (dev only). See docs/blockers/kms.md.");
  }

  if (errors.length > 0) {
    throw new ConfigError(`Integration modes misconfigured:\n  - ${errors.join("\n  - ")}`, errors);
  }
  return modes;
}
