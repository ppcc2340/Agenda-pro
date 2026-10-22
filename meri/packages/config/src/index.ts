export { EnvSchema, parseEnv, ConfigError, type Env } from "./env";
export {
  resolveModes,
  isProductionEnv,
  BLOCKERS,
  type BlockerDefinition,
  type IntegrationId,
  type ResolvedModes,
} from "./modes";
export { FEATURE_FLAGS, InMemoryFlagStore, type FeatureFlag, type FeatureFlagStore } from "./flags";
export { createLogger, REDACTED_PATHS, type Logger, type LoggerConfig } from "./logger";
export { loadConfig, type AppConfig } from "./load";
export { loadDotenv } from "./dotenv";
export {
  createObservability,
  noopErrorTracker,
  noopTracer,
  loggerErrorTracker,
  observabilityOptions,
  reportFatalErrors,
  createSentryErrorTracker,
  parseSentryDsn,
  type Observability,
  type ErrorTracker,
  type Tracer,
} from "./observability";

/** Identity of the demo workspace created by `pnpm demo:seed` (PROTOTYPE.md, D-049). */
export const DEMO_USER = { email: "demo@meri.local", name: "Demo de Meri" } as const;
