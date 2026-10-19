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
/** Production = APP_ENV when set, otherwise NODE_ENV (D-029). */
export const isProductionEnv = (env: Pick<Env, "NODE_ENV" | "APP_ENV">): boolean =>
  (env.APP_ENV ?? env.NODE_ENV) === "production";

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

  if (isProductionEnv(env)) {
    const placeholders = (["AUTH_SECRET", "INTERNAL_API_SECRET"] as const).filter((k) =>
      /^change-me/i.test(env[k]),
    );
    if (placeholders.length > 0)
      errors.push(`${placeholders.join(", ")} still hold the .env.example placeholder; set real secrets.`);
    if (!env.AUTH_URL)
      errors.push(
        "AUTH_URL is required in production (Auth.js must not derive callbacks from the Host header).",
      );
  }

  if (env.KMS_PROVIDER === "local" && !env.LOCAL_MASTER_KEY) {
    errors.push("KMS_PROVIDER=local requires LOCAL_MASTER_KEY (dev only). See docs/blockers/kms.md.");
  }

  if (errors.length > 0) {
    throw new ConfigError(`Integration modes misconfigured:\n  - ${errors.join("\n  - ")}`, errors);
  }
  return modes;
}
