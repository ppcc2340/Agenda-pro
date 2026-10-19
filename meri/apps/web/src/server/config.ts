import { loadConfig, type AppConfig } from "@meri/config";

let cached: AppConfig | null = null;

/** Lazy, memoised server configuration (never evaluated at build time). */
export function getServerConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}
