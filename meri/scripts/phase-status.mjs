#!/usr/bin/env node
// Progreso de las fases: cuenta casillas de los TASKS.md de cada fase. Uso: pnpm status
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "phases");
let totalDone = 0, total = 0;
console.log("\nProgreso de Meri\n");
for (const d of readdirSync(root).filter((x) => /^0\d-/.test(x)).sort()) {
  const f = resolve(root, d, "TASKS.md");
  if (!existsSync(f)) continue;
  const txt = readFileSync(f, "utf8");
  const done = (txt.match(/^- \[x\]/gim) || []).length, open = (txt.match(/^- \[ \]/gm) || []).length, n = done + open;
  totalDone += done; total += n;
  const pct = n ? Math.round((done / n) * 100) : 0;
  console.log(`${d.padEnd(32)} ${String(done).padStart(2)}/${String(n).padEnd(2)} ${"█".repeat(Math.round(pct / 5)).padEnd(20, "░")} ${pct}%`);
}
console.log(`\nTotal: ${totalDone}/${total} tareas (${total ? Math.round((totalDone / total) * 100) : 0}%)\n`);
