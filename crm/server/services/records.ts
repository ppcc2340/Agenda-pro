import { fieldDefs, coerceCustom, COMPUTED_TYPES, enrichList } from "./columns.js";
/** Shared helpers: listing with filters/sort/pagination, custom field validation, JSON parsing. */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { buildWhere, OBJECT_FIELDS, type FilterGroup } from "../lib/filters.js";
import { badRequest } from "../lib/errors.js";
import { ownerScope } from "../lib/permissions.js";

export const JSON_COLS: Record<string, string[]> = {
  contact: ["tags", "custom", "utm", "qualification"],
  company: ["tags", "custom"],
  deal: ["tags", "custom"],
  ticket: ["tags"],
  task: [],
  contract: ["tags", "custom", "effective_values", "intake", "risk_factors"],
};
export const TABLES: Record<string, string> = { contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", task: "tasks", contract: "contracts" };
export const SEARCH_COLS: Record<string, string[]> = {
  contact: ["first_name", "last_name", "email", "phone", "job_title"],
  company: ["name", "domain", "city", "tax_id"],
  deal: ["name"],
  ticket: ["subject"],
  task: ["title"],
  contract: ["number", "title", "description"],
};

export const listQuery = z.object({
  filters: z.any().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListQuery = z.infer<typeof listQuery>;

export function parseFilters(raw: unknown): FilterGroup | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as FilterGroup; } catch { throw badRequest("Filtros no válidos (JSON)"); }
  }
  return raw as FilterGroup;
}

export interface ListResult<T> { items: T[]; total: number; page: number; page_size: number }

/** Generic list for an object with visibility, filters, text search, sort and pagination. */
export function listRecords<T extends Row>(ctx: Ctx, object: string, q: ListQuery, extra?: { where?: string; params?: unknown[]; select?: string; joins?: string; ownerCol?: string }): ListResult<T> {
  const table = TABLES[object];
  if (!table) throw badRequest("Objeto desconocido");
  const fields = OBJECT_FIELDS[object] ?? {};
  const where: string[] = ["t.workspace_id = ?"];
  const params: unknown[] = [ctx.ws];
  if (object !== "task" && object !== "ticket") where.push("t.deleted_at IS NULL");
  const scope = ownerScope(ctx, `t.${extra?.ownerCol ?? (object === "task" ? "assignee_id" : object === "ticket" ? "assignee_id" : "owner_id")}`);
  where.push(scope.sql); params.push(...scope.params);
  const f = buildWhere(object, parseFilters(q.filters), "t");
  where.push(f.sql); params.push(...f.params);
  if (q.q) {
    const cols = SEARCH_COLS[object] ?? [];
    where.push(`(${cols.map((c) => `t.${c} LIKE ?`).join(" OR ")})`);
    params.push(...cols.map(() => `%${q.q}%`));
  }
  if (extra?.where) { where.push(extra.where); params.push(...(extra.params ?? [])); }
  let sort = "t.updated_at";
  if (q.sort) {
    if (q.sort.startsWith("custom.")) sort = `json_extract(t.custom,'$.${q.sort.slice(7).replace(/[^a-z0-9_]/gi, "")}')`;
    else if (fields[q.sort] || q.sort === "id" || q.sort === "updated_at") sort = `t.${q.sort}`;
    else throw badRequest(`No se puede ordenar por ${q.sort}`);
  }
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  const w = where.join(" AND ");
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} t ${extra?.joins ?? ""} WHERE ${w}`, ...params)?.n ?? 0;
  const items = ctx.db.all<T>(`SELECT t.*${extra?.select ? ", " + extra.select : ""} FROM ${table} t ${extra?.joins ?? ""} WHERE ${w} ORDER BY ${sort} ${dir} NULLS LAST, t.id LIMIT ? OFFSET ?`, ...params, q.page_size, (q.page - 1) * q.page_size);
  for (const it of items) parseJson(it, JSON_COLS[object] ?? []);
  enrichList(ctx, object, items as unknown as Row[]);
  return { items, total, page: q.page, page_size: q.page_size };
}

export function customFieldDefs(ctx: Ctx, object: string) {
  return ctx.db.all<Row & { key: string; label: string; type: string; required: number; options: string; default_value: string | null }>("SELECT * FROM custom_fields WHERE workspace_id=? AND object=? ORDER BY position", ctx.ws, object);
}

/** Validate and coerce custom values against definitions. Merges with existing custom values. */
export function validateCustom(ctx: Ctx, object: string, input: unknown, existing: Record<string, unknown> = {}, partial = false): Record<string, unknown> {
  const defs = customFieldDefs(ctx, object);
  const inObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...existing };
  const errors: string[] = [];
  const full = fieldDefs(ctx, object);
  for (const d of defs) {
    const has = Object.prototype.hasOwnProperty.call(inObj, d.key);
    const fd = full.find((x) => x.key === d.key)!;
    if (COMPUTED_TYPES.includes(d.type) || d.type === "button") { delete out[d.key]; continue; }
    if (["status", "rating", "timeline"].includes(d.type)) {
      let v0 = has ? inObj[d.key] : out[d.key];
      if ((v0 === undefined || v0 === null || v0 === "") && d.default_value && !has && !(d.key in out)) v0 = d.default_value;
      const r = coerceCustom(ctx, fd, v0);
      if (r && !r.ok) errors.push(r.error); else out[d.key] = r ? r.value : null;
      if (d.required && (out[d.key] === null || out[d.key] === undefined) && !(partial && !has)) errors.push(`${d.label} es obligatorio`);
      continue;
    }
    let v = has ? inObj[d.key] : out[d.key];
    if ((v === undefined || v === null || v === "") && d.default_value && !has && !(d.key in out)) v = coerce(d.type, d.default_value);
    if (v === "" || v === undefined) v = null;
    if (v !== null) {
      switch (d.type) {
        case "number": case "currency": case "percent":
          if (Number.isNaN(Number(v))) errors.push(`${d.label}: debe ser un número`); else v = Number(v); break;
        case "boolean": v = v === true || v === 1 || v === "true" || v === "1"; break;
        case "select": {
          const opts = safeArr(d.options);
          if (opts.length && !opts.includes(String(v))) errors.push(`${d.label}: opción no válida`); break;
        }
        case "multiselect": {
          const arr = Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean);
          const opts = safeArr(d.options);
          if (opts.length && arr.some((x) => !opts.includes(x))) errors.push(`${d.label}: opción no válida`); v = arr; break;
        }
        case "email": if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) errors.push(`${d.label}: email no válido`); break;
        case "url": if (!/^https?:\/\//.test(String(v))) errors.push(`${d.label}: debe empezar por http(s)://`); break;
        case "date": if (Number.isNaN(Date.parse(String(v)))) errors.push(`${d.label}: fecha no válida`); break;
        default: v = String(v);
      }
    }
    if (d.required && (v === null || (Array.isArray(v) && !v.length)) && !(partial && !has)) errors.push(`${d.label} es obligatorio`);
    out[d.key] = v;
  }
  // subetiquetas de columnas de estado del sistema: custom._lbl_<campo> = id de la etiqueta añadida en el tablero
  for (const [k, v] of Object.entries(inObj)) if (/^_lbl_[a-z_]+$/.test(k)) { if (v === null || v === undefined || v === "") delete out[k]; else out[k] = String(v).slice(0, 40); }
  if (errors.length) throw badRequest(errors.join(". "), { fields: errors });
  return out;
}
function coerce(type: string, v: string): unknown {
  if (["number", "currency", "percent"].includes(type)) return Number(v);
  if (type === "boolean") return v === "true" || v === "1";
  return v;
}
function safeArr(s: string): string[] {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export const tagsSchema = z.array(z.string().trim().min(1)).max(50);
export const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Fecha no válida");
export const nullableStr = z.string().trim().max(2000).nullable().optional();
