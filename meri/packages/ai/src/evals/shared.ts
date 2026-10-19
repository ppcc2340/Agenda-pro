/** Helpers shared by the eval runners (docs/05 §7). */
import { readFileSync } from "node:fs";

export function loadJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** Lower-case, accent-free content tokens of an action ("enviar contrato firmado" → [enviar, contrato, firmado]). */
export function actionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** An expected action matches when every one of its tokens appears in the extracted action. */
export function actionMatches(expected: string, got: string): boolean {
  const want = actionTokens(expected);
  if (want.length === 0) return true;
  const have = new Set(actionTokens(got));
  return want.every((w) => have.has(w));
}

export const EVAL_NOW = "2026-10-19T13:40:00Z";
export const EVAL_TZ = "Europe/Madrid";
