#!/usr/bin/env node
/** Ejecuta la prueba de humo de un bloqueo: pnpm smoke <id>. Las pruebas viven en scripts/smoke/<id>.ts (las crea la fase 0). */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const id = process.argv[2];
if (!id) { console.error("Uso: pnpm smoke <id>  (google-oauth | anthropic | stripe | observability | domain-brand | kms)"); process.exit(2); }
const file = `scripts/smoke/${id}.ts`;
if (!existsSync(file)) { console.error(`Aún no existe ${file}. Se crea en la fase 0 (tarea de adaptadores falsos). Ver scripts/smoke/README.md.`); process.exit(2); }
process.exit(spawnSync("pnpm", ["exec", "tsx", file], { stdio: "inherit" }).status ?? 1);
