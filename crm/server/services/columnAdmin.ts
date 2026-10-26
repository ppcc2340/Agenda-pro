/** Validación de la configuración de columnas (settings por tipo) y búsqueda de dependencias. */
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest, conflict } from "../lib/errors.js";
import { compileFormula, formulaRefs, norm, relationsFor, AGGREGATIONS, type StatusLabel } from "./columns.js";
import { isCustomObjectKey } from "../lib/objectKeys.js";

const COLORS = ["#00c875", "#fdab3d", "#e2445c", "#579bfc", "#a25ddc", "#66ccff", "#9cd326", "#ff158a", "#7f5347", "#c4c4c4"];
export function normalizeLabels(input: unknown, used: Set<number> = new Set()): StatusLabel[] {
  if (!Array.isArray(input)) throw badRequest("Las etiquetas deben ser una lista");
  const out: StatusLabel[] = [];
  let next = Math.max(0, ...input.map((l) => Number((l as Row).id) || 0)) + 1;
  for (const [i, raw] of input.entries()) {
    const l = raw as Row;
    const label = String(l.label ?? "").trim();
    if (!label) throw badRequest("Hay una etiqueta sin texto");
    if (label.length > 30) throw badRequest(`La etiqueta «${label}» supera 30 caracteres`);
    if (out.some((o) => norm(o.label) === norm(label))) throw badRequest(`Etiqueta repetida: ${label}`);
    const lid = Number(l.id) > 0 ? Number(l.id) : next++;
    out.push({ id: lid, label, color: /^#[0-9a-f]{6}$/i.test(String(l.color)) ? String(l.color) : COLORS[i % COLORS.length]!, done: !!l.done });
  }
  if (out.length > 40) throw badRequest("Máximo 40 etiquetas por columna");
  const missing = [...used].filter((u) => !out.some((o) => o.id === u));
  if (missing.length) throw conflict(`Hay registros con ${missing.length} etiqueta(s) que intentas borrar; cámbialos antes`, { in_use: missing });
  return out;
}
function usedStatusIds(ctx: Ctx, object: string, key: string): Set<number> {
  if (isCustomObjectKey(object)) return new Set(ctx.db.all<{ v: unknown }>(`SELECT DISTINCT json_extract(custom, '$.${key.replace(/[^a-z0-9_]/gi, "")}') v FROM custom_records WHERE workspace_id=? AND object_key=?`, ctx.ws, object).map((r) => Number(r.v)).filter((n) => n > 0));
  const table = ({ contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", contract: "contracts" } as Record<string, string>)[object];
  if (!table) return new Set();
  return new Set(ctx.db.all<{ v: unknown }>(`SELECT DISTINCT json_extract(custom, '$.${key.replace(/[^a-z0-9_]/gi, "")}') v FROM ${table} WHERE workspace_id=?`, ctx.ws).map((r) => Number(r.v)).filter((n) => n > 0));
}
export function validateFieldSettings(ctx: Ctx, object: string, type: string, settings: Record<string, unknown>, key: string, fieldId?: string): Record<string, unknown> {
  const s = { ...settings };
  switch (type) {
    case "status":
      if (s.label_set_id) { if (!ctx.db.get("SELECT id FROM label_sets WHERE id=? AND workspace_id=?", s.label_set_id, ctx.ws)) throw badRequest("Conjunto de etiquetas no encontrado"); delete s.labels; }
      else s.labels = normalizeLabels(s.labels ?? [{ label: "Pendiente", color: "#c4c4c4" }, { label: "En curso", color: "#fdab3d" }, { label: "Hecho", color: "#00c875", done: true }], fieldId ? usedStatusIds(ctx, object, key) : new Set());
      break;
    case "rating": s.max = Math.min(10, Math.max(1, Number(s.max ?? 5))); break;
    case "button": s.label = String(s.label ?? "Pulsar").slice(0, 30); s.color = String(s.color ?? "#0073ea"); break;
    case "autonumber": s.prefix = String(s.prefix ?? "").slice(0, 10); s.pad = Math.min(8, Math.max(0, Number(s.pad ?? 0))); break;
    case "formula": {
      const expr = String(s.expression ?? "").trim();
      if (!expr) throw badRequest("Escribe la fórmula");
      try { compileFormula(expr); } catch (e) { throw badRequest(`Fórmula no válida: ${(e as Error).message}`); }
      for (const r of formulaRefs(expr)) if (norm(r) === norm(key)) throw badRequest("Una fórmula no puede referenciarse a sí misma");
      s.expression = expr; s.result = ["number", "text", "boolean", "date", "auto"].includes(String(s.result)) ? s.result : "auto";
      break;
    }
    case "mirror": {
      const rel = relationsFor(ctx, object)[String(s.relation)];
      if (!rel) throw badRequest("Elige una relación válida para el reflejo");
      if (!s.field) throw badRequest("Elige la columna a reflejar");
      if (!AGGREGATIONS[String(s.agg ?? "")]) s.agg = rel.many ? "list" : "first";
      if (["all_eq", "any_eq", "none_eq", "pct_eq"].includes(String(s.agg)) && (s.compare === undefined || s.compare === "")) throw badRequest("Indica el valor a comparar (TODOS/ALGUNO/NINGUNO/%)");
      break;
    }
  }
  return s;
}
/** Dónde se usa una columna: automatizaciones, fórmulas, reflejos de otros objetos y reglas del tablero. */
export function fieldDependents(ctx: Ctx, object: string, key: string, label: string): { kind: string; id: string; name: string }[] {
  const out: { kind: string; id: string; name: string }[] = [];
  const needle = [`custom.${key}`, `{${label}}`, `{${key}}`];
  for (const w of ctx.db.all<Row>("SELECT id, name, trigger, conditions, actions FROM workflows WHERE workspace_id=?", ctx.ws)) {
    const txt = `${w.trigger}${w.conditions}${w.actions}`;
    if (needle.some((n) => txt.includes(n))) out.push({ kind: "automatización", id: String(w.id), name: String(w.name) });
  }
  for (const f of ctx.db.all<Row>("SELECT * FROM custom_fields WHERE workspace_id=?", ctx.ws).map((x) => parseJson(x, ["settings"]) as Row)) {
    const st = (f.settings ?? {}) as Row;
    if (f.type === "formula" && f.object === object && f.key !== key && formulaRefs(String(st.expression ?? "")).some((r) => norm(r) === norm(key) || norm(r) === norm(label))) out.push({ kind: "fórmula", id: String(f.id), name: String(f.label) });
    if (f.type === "mirror" && st.field === `custom.${key}` && relationsFor(ctx, String(f.object))[String(st.relation)]?.target === object) out.push({ kind: "reflejo", id: String(f.id), name: `${f.label} (${f.object})` });
  }
  const bc = ctx.db.get<{ config: string }>("SELECT config FROM board_configs WHERE workspace_id=? AND object=?", ctx.ws, object);
  if (bc && bc.config.includes(`custom.${key}`)) out.push({ kind: "regla del tablero", id: object, name: "Valores por defecto / columnas obligatorias" });
  return out;
}
