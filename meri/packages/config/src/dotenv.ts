import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal .env loader for local development and scripts (no dependency). Never logs values.
 * Existing process variables win. Production uses the platform's secret manager instead.
 */
export function loadDotenv(
  file = ".env",
  target: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? "";
    let value = (m[2] ?? "").replace(/\s+#.*$/, "");
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!(key in target)) {
      target[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
