import pino, { type Logger, type LoggerOptions } from "pino";

/** Fields that must never reach logs in clear text (docs/06 §2, docs/12 §9). */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.access_token",
  "*.refresh_token",
  "*.encryptedTokens",
  "*.apiKey",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "*.body",
  "*.snippet",
  "*.email",
  "*.ANTHROPIC_API_KEY",
  "*.STRIPE_SECRET_KEY",
  "*.AUTH_SECRET",
  "*.LOCAL_MASTER_KEY",
  // postgres.js errors carry the failing query and its parameters (may include emails/contact data)
  "err.query",
  "err.parameters",
  "*.err.query",
  "*.err.parameters",
] as const;

export interface LoggerConfig {
  name: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export type { Logger };

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.name,
    level: config.level ?? "info",
    base: { service: config.name, ...config.base },
    redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (config.pretty) {
    options.transport = { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } };
  }
  return pino(options);
}
