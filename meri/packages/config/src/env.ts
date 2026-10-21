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
  /** Interface the api and the worker health server bind to (`pnpm demo` uses 127.0.0.1 unless --public). */
  LISTEN_HOST: z.preprocess(emptyToUndefined, z.string().min(1).default("0.0.0.0")),
  /** Trusted reverse-proxy hops in front of the API (0 = none). */
  TRUST_PROXY_HOPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).default(0)),
  /** API requests per signed-in user (or per IP) and minute (docs/12 §3). `pnpm demo` raises it for the E2E runs. */
  RATE_LIMIT_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(100_000).default(300)),

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
  STRIPE_PRICE_PRO_PLUS: optionalString(),
  STRIPE_PRICE_PRO_PLUS_ANNUAL: optionalString(),
  STRIPE_PRICE_CREDITS_500: optionalString(),
  STRIPE_PRICE_CREDITS_2000: optionalString(),
  /** D-102: anchor B price ids (optional until the price experiment is turned on). */
  STRIPE_PRICE_PRO_B: optionalString(),
  STRIPE_PRICE_PRO_ANNUAL_B: optionalString(),
  STRIPE_PRICE_PRO_PLUS_B: optionalString(),
  STRIPE_PRICE_PRO_PLUS_ANNUAL_B: optionalString(),
  /** D-102: displayed monthly price of anchor B in US cents (hypothesis: 3900 and 5900). */
  PRICE_ANCHOR_B_PRO_CENTS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(100).max(100_000).optional()),
  PRICE_ANCHOR_B_PRO_PLUS_CENTS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(100).max(100_000).optional()),
  /** Estimated infrastructure cost per user and month for the margin rollup (D-062). */
  INFRA_COST_USD_PER_USER: z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().default(3)),

  /** Transactional email (D-113): SMTP of any provider. `SMTP_URL` like smtps://user:pass@host:465. */
  NOTIFY_MODE: FakeLive.default("fake"),
  SMTP_URL: optionalString(),
  /** Sender, e.g. `Meri <avisos@example.com>`: an address on Meri's own domain, never the user's mailbox. */
  MAIL_FROM: optionalString(),

  ANALYTICS_MODE: z.enum(["noop", "live"]).default("noop"),
  SENTRY_DSN: optionalString(),
  POSTHOG_KEY: optionalString(),
  POSTHOG_HOST: z.preprocess(emptyToUndefined, z.string().url().default("https://eu.i.posthog.com")),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString(),

  KMS_PROVIDER: z.enum(["local", "aws", "gcp"]).default("local"),
  KMS_KEY_ID: optionalString(),
  /** Retired key ids still accepted for decryption until every blob and backup is rotated (ADR 0007). */
  KMS_PREVIOUS_KEY_IDS: optionalString(),
  AWS_REGION: optionalString(),
  LOCAL_MASTER_KEY: optionalString(),
  /** Comma-separated previous local master keys (dev rotation drills only). */
  LOCAL_PREVIOUS_MASTER_KEYS: optionalString(),

  DEMO_MODE: z
    .preprocess(emptyToUndefined, z.enum(["0", "1", "true", "false"]).default("0"))
    .transform((v) => v === "1" || v === "true"),
  /** Closed beta (D-099): new accounts need an invitation (`pnpm beta:invite`). Off in development and the demo. */
  BETA_INVITE_REQUIRED: z
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
