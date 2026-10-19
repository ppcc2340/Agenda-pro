#!/usr/bin/env node
/**
 * Comprueba qué bloqueos humanos están resueltos. Sin dependencias.
 * Uso:
 *   node scripts/check-blockers.mjs            informe (siempre sale con 0)
 *   node scripts/check-blockers.mjs --id stripe  solo un bloqueo
 *   node scripts/check-blockers.mjs --strict     sale con 1 si algo está en modo live sin credenciales
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--id") ? args[args.indexOf("--id") + 1] : null;
const strict = args.includes("--strict");

function loadEnv() {
  const env = { ...process.env };
  const file = resolve(root, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) env[m[1]] = v;
    }
  }
  return env;
}
const isSet = (v) => !!v && !/^(change-me|your[_-]|xxx|todo|placeholder)/i.test(v);

const env = loadEnv();
const { blockers } = JSON.parse(readFileSync(resolve(root, "blockers.json"), "utf8"));
const list = only ? blockers.filter((b) => b.id === only) : blockers;
if (only && !list.length) { console.error(`No existe el bloqueo "${only}".`); process.exit(2); }

let broken = 0;
console.log("\nBloqueos humanos de Meri\n");
for (const b of list) {
  const missing = b.env.filter((k) => !isSet(env[k]));
  const mode = b.modeVar ? (env[b.modeVar] || (b.modeValuesLive ? "local" : "fake")) : null;
  const wantsLive = b.modeValuesLive ? b.modeValuesLive.includes(mode) : mode === "live";
  let status, note;
  if (!missing.length && (wantsLive || !b.modeVar)) { status = "✅ conectado"; note = "credenciales presentes"; }
  else if (!missing.length) { status = "🟡 listo para activar"; note = `credenciales presentes. Cambia ${b.modeVar} para activarlo`; }
  else if (wantsLive) { status = "❌ error"; note = `modo live sin credenciales: ${missing.join(", ")}`; broken++; }
  else { status = "⏳ pendiente"; note = `usando: ${b.fallback}`; }
  console.log(`${status}  ${b.title}${b.critical ? "  [crítico]" : ""}`);
  console.log(`   ${note}`);
  if (missing.length && status !== "❌ error") console.log(`   faltan: ${missing.join(", ")}`);
  if (status.startsWith("⏳")) console.log(`   guía: ${b.guide}  (${b.leadTime})`);
  console.log("");
}
const pending = list.filter((b) => b.env.some((k) => !isSet(env[k]))).length;
console.log(pending ? `${pending} pendiente(s). Lo pendiente sigue funcionando con adaptadores falsos.` : "Todas las credenciales están presentes.");
if (strict && broken) { console.error(`\n${broken} bloqueo(s) en modo live sin credenciales.`); process.exit(1); }
