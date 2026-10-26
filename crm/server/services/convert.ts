/**
 * Cambio de tipo de columna con conversión de valores (como en Excel/monday): texto ↔ número ↔ estado ↔
 * fecha ↔ casilla ↔ etiquetas… Las columnas calculadas se pueden «congelar» en valores (pegar valores).
 */
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { COMPUTED_TYPES, cellText, computeFields, fieldDefs, norm, statusLabels, type FieldDef, type StatusLabel } from "./columns.js";
import { OBJECT_TABLE } from "./recordOps.js";

const PAL = ["#579bfc", "#00c875", "#fdab3d", "#e2445c", "#a25ddc", "#66ccff", "#9cd326", "#ff642e", "#784bd1", "#c4c4c4", "#037f4c", "#ff158a"];
const TRUE_WORDS = new Set(["si", "sí", "yes", "true", "1", "x", "✓", "verdadero", "hecho", "ok"]);
const FALSE_WORDS = new Set(["no", "false", "0", "falso", ""]);

/** «1.234,56 €» → 1234.56; «12%» → 12; «-3» → -3. */
export function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  let s = String(v).trim().replace(/[€$£%\s]|uds?\.?|h$/gi, "");
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,(?=\d{3}\b)/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** «31/12/2026», «31-12-26», «2026-12-31», «2026-12-31T10:00» → «2026-12-31». */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) { const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`; }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
export function parseBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const s = norm(v);
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

interface Plan { labels?: StatusLabel[]; options?: string[] }
/** Convierte un valor ya en texto/valor origen al tipo destino. `undefined` = no convertible (se pierde). */
function convertOne(ctx: Ctx, from: FieldDef, raw: unknown, to: string, plan: Plan): unknown {
  if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && !raw.length)) return null;
  const text = from.type === "status" || from.type === "user" || from.type === "boolean" || from.type === "multiselect" || from.type === "timeline" ? cellText(ctx, from.type, raw, from) : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  switch (to) {
    case "text": case "textarea": case "phone": return text;
    case "email": return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? text : undefined;
    case "url": return /^https?:\/\//.test(text) ? text : /^[\w-]+(\.[\w-]+)+/.test(text) ? `https://${text}` : undefined;
    case "number": case "currency": case "percent": { if (from.type === "status") { const n = parseNumber(text); return n ?? undefined; } const n = parseNumber(from.type === "timeline" ? null : raw); return n ?? undefined; }
    case "rating": { const n = parseNumber(raw); return n === null ? undefined : Math.max(0, Math.min(10, Math.round(n))); }
    case "date": case "datetime": { const d = parseDate(from.type === "timeline" ? (raw as { from?: string }).from : from.type === "creation_log" || from.type === "last_updated" ? raw : text); return d ?? undefined; }
    case "timeline": { const d = parseDate(text); return d ? { from: d, to: d } : undefined; }
    case "boolean": { if (from.type === "status") { const l = statusLabels(ctx, from).find((x) => x.id === Number(raw)); if (l?.done) return true; } const b = parseBool(text); return b ?? (from.type === "number" || from.type === "currency" ? Number(raw) !== 0 : true); }
    case "status": { const l = plan.labels!.find((x) => norm(x.label) === norm(from.type === "boolean" ? (raw ? "Sí" : "No") : text)); return l ? l.id : undefined; }
    case "select": return text;
    case "multiselect": return text.split(/\s*[,;|]\s*/).filter(Boolean);
    case "user": { const u = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE workspace_id=? AND (lower(name)=lower(?) OR lower(email)=lower(?))", ctx.ws, text, text); return u?.id ?? undefined; }
    default: return undefined;
  }
}

/** Valores actuales (los calculados se materializan) de todos los registros. */
function currentValues(ctx: Ctx, object: string, d: FieldDef): { id: string; value: unknown }[] {
  const t = OBJECT_TABLE[object]; if (!t) throw badRequest("Objeto no válido");
  const rows = ctx.db.all<Row>(`SELECT * FROM ${t} WHERE workspace_id=?${["tasks", "tickets"].includes(t) ? "" : " AND deleted_at IS NULL"}`, ctx.ws).map((r) => parseJson(r, ["custom", "tags"]) as Row);
  if (!COMPUTED_TYPES.includes(d.type)) return rows.map((r) => ({ id: String(r.id), value: ((r.custom as Row) ?? {})[d.key] }));
  const defs = fieldDefs(ctx, object);
  return rows.map((r) => ({ id: String(r.id), value: computeFields(ctx, object, r, defs).values[d.key] }));
}

function planFor(ctx: Ctx, from: FieldDef, to: string, values: unknown[], settings: Record<string, unknown>): Plan {
  if (to === "status") {
    const given = (settings.labels as StatusLabel[] | undefined) ?? [];
    if (given.length) return { labels: given };
    const texts = from.type === "status" ? statusLabels(ctx, from).map((l) => l.label) : Array.from(new Set(values.filter((v) => v !== null && v !== undefined && v !== "").flatMap((v) => (from.type === "multiselect" && Array.isArray(v) ? v.map(String) : [from.type === "boolean" ? (v ? "Sí" : "No") : cellText(ctx, from.type, v, from)])))).slice(0, 40);
    return { labels: texts.map((label, i) => ({ id: i + 1, label, color: PAL[i % PAL.length]!, done: from.type === "status" ? !!statusLabels(ctx, from)[i]?.done : from.type === "boolean" && label === "Sí" })) };
  }
  if (to === "select" || to === "multiselect") return { options: Array.from(new Set(values.flatMap((v) => (v === null || v === undefined || v === "" ? [] : Array.isArray(v) ? v.map(String) : from.type === "status" || from.type === "user" || from.type === "boolean" ? [cellText(ctx, from.type, v, from)] : String(v).split(to === "multiselect" ? /\s*[,;|]\s*/ : /$^/))).filter(Boolean))).slice(0, 60) };
  return {};
}

export interface ConversionReport { total: number; filled: number; converted: number; lost: number; samples: { before: string; after: string }[]; labels?: StatusLabel[]; options?: string[] }

/** Calcula (y si `apply`, ejecuta) la conversión de una columna personalizada a otro tipo. */
export function convertField(ctx: Ctx, object: string, key: string, to: string, settings: Record<string, unknown> = {}, apply = false): ConversionReport {
  const d = fieldDefs(ctx, object).find((x) => x.key === key); if (!d) throw badRequest("Columna no encontrada");
  if (COMPUTED_TYPES.includes(to) || to === "button") return { total: 0, filled: 0, converted: 0, lost: 0, samples: [] };
  const vals = currentValues(ctx, object, d);
  const plan = planFor(ctx, d, to, vals.map((v) => v.value), settings);
  const out: { id: string; value: unknown }[] = [];
  const rep: ConversionReport = { total: vals.length, filled: 0, converted: 0, lost: 0, samples: [], labels: plan.labels, options: plan.options };
  for (const v of vals) {
    const empty = v.value === null || v.value === undefined || v.value === "" || (Array.isArray(v.value) && !v.value.length);
    if (empty) { out.push({ id: v.id, value: null }); continue; }
    rep.filled++;
    const nv = convertOne(ctx, d, v.value, to, plan);
    if (nv === undefined) rep.lost++; else rep.converted++;
    out.push({ id: v.id, value: nv === undefined ? null : nv });
    if (rep.samples.length < 6) rep.samples.push({ before: cellText(ctx, d.type === "status" || d.type === "user" || d.type === "boolean" || d.type === "multiselect" ? d.type : "text", v.value, d), after: nv === undefined ? "∅ (se pierde)" : to === "status" ? plan.labels!.find((l) => l.id === nv)?.label ?? "" : Array.isArray(nv) ? nv.join(", ") : typeof nv === "object" ? JSON.stringify(nv) : String(nv) });
  }
  if (apply) {
    const t = OBJECT_TABLE[object]!;
    ctx.db.transaction(() => {
      for (const o of out) ctx.db.run(`UPDATE ${t} SET custom=json_set(COALESCE(custom,'{}'), '$.${key}', json(?)) WHERE id=?`, JSON.stringify(o.value), o.id);
    });
  }
  return rep;
}
