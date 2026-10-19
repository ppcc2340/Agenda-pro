import { z } from "zod";

/** Treat empty strings (common in .env files) as absent. */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

const FakeLive = z.enum(["fake", "live"]);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Deployment environment (D-029). Defaults to NODE_ENV, so a plain `next start` is production and refuses fake
   * adapters; `APP_ENV=development` runs an optimized build against fakes (E2E, `pnpm demo`).
   */
  APP_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "test", "staging", "production"]).optional(),
  ),
  /** Explicit opt-in for running fakes on an optimized build (E2E, `pnpm demo`); never set in a deployment. */
  ALLOW_FAKES_ON_PRODUCTION_BUILD: z.preprocess(emptyToUndefined, z.enum(["1"]).optional()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  PUBLIC_DOMAIN: z.string().min(1).default("localhost"),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  /** Trusted reverse-proxy hops in front of the API (0 = none). */
  TRUST_PROXY_HOPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).default(0)),

  /** Application connection: role without SUPERUSER/BYPASSRLS (docs/12 §4). */
  DATABASE_URL: z.string().min(1),
  /** Owner connection used only for migrations. Defaults to DATABASE_URL. */
  DATABASE_ADMIN_URL: optionalString(),
  DATABASE_URL_TEST: optionalString(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  /** Canonical URL of the web app for Auth.js (required in production so callbacks never derive from Host). */
  AUTH_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  INTERNAL_API_SECRET: z.string().min(16, "INTERNAL_API_SECRET must be at least 16 characters"),

  GOOGLE_MODE: FakeLive.default("fake"),
  GOOGLE_CLIENT_ID: optionalString(),
  GOOGLE_CLIENT_SECRET: optionalString(),
  /** Shared secret Google echoes in X-Goog-Channel-Token for Calendar push notifications. */
  GOOGLE_CALENDAR_CHANNEL_TOKEN: z.string().min(8).default("dev-calendar-channel-token"),

  AI_MODE: FakeLive.default("fake"),
  ANTHROPIC_API_KEY: optionalString(),
  AI_MODEL_FAST: z.string().min(1).default("claude-haiku-5-5"),
  AI_MODEL_SMART: z.string().min(1).default("claude-sonnet-5-5"),
  /** JSON map model → {input, output, cacheRead, cacheWrite} in USD per MTok (docs/blockers/anthropic.md). */
  AI_PRICES_JSON: optionalString(),
  AI_MONTHLY_COST_CAP_USD_PER_USER: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(6)),

  STRIPE_MODE: FakeLive.default("fake"),
  STRIPE_SECRET_KEY: optionalString(),
  STRIPE_WEBHOOK_SECRET: optionalString(),
  STRIPE_PRICE_PRO: optionalString(),
  STRIPE_PRICE_PRO_ANNUAL: optionalString(),

  ANALYTICS_MODE: z.enum(["noop", "live"]).default("noop"),
  SENTRY_DSN: optionalString(),
  POSTHOG_KEY: optionalString(),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString(),

  KMS_PROVIDER: z.enum(["local", "aws", "gcp"]).default("local"),
  KMS_KEY_ID: optionalString(),
  LOCAL_MASTER_KEY: optionalString(),

  DEMO_MODE: z
    .preprocess(emptyToUndefined, z.enum(["0", "1", "true", "false"]).default("0"))
    .transform((v) => v === "1" || v === "true"),
  DEMO_NOW: z.preprocess(emptyToUndefined, z.string().datetime({ offset: true }).optional()),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Parse and validate environment variables. Pure: pass any record, never reads files. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ConfigError(`Invalid configuration:\n  - ${issues.join("\n  - ")}`, issues);
}
