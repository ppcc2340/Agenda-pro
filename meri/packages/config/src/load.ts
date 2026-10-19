import { parseEnv, type Env } from "./env";
import { isProductionEnv, resolveModes, type ResolvedModes } from "./modes";

export interface AppConfig {
  env: Env;
  modes: ResolvedModes;
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Load and validate the whole configuration from an environment record.
 * Throws ConfigError with a readable list of problems; apps must call this at startup and exit on failure.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const env = parseEnv(source);
  const modes = resolveModes(env);
  return {
    env,
    modes,
    isProduction: isProductionEnv(env),
    isTest: (env.APP_ENV ?? env.NODE_ENV) === "test",
  };
}
