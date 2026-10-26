/**
 * Seguridad por campo: para cada rol, cada campo (nativo o personalizado) puede ser editable, solo lectura u
 * oculto. Se aplica en el servidor: los campos ocultos desaparecen de listados, fichas, exportaciones, celdas e
 * informes, y escribir en un campo de solo lectura u oculto devuelve 403. El administrador siempre ve todo.
 */
import type { Ctx } from "../context.js";
import type { Row } from "../db.js";
import { forbidden } from "../lib/errors.js";
import { isAdmin } from "../lib/permissions.js";
import { builtinColumns, fieldDefs } from "./columns.js";

export type Access = "edit" | "read" | "hidden";
export const SECURED_OBJECTS = ["contact", "company", "deal", "ticket", "task", "contract"] as const;

/** Claves derivadas que se muestran junto a un campo (nombre del propietario, de la empresa…). */
export const ALIASES: Record<string, string[]> = {
  owner_id: ["owner_name"], assignee_id: ["assignee_name"], legal_owner_id: ["legal_owner_name"], company_id: ["company_name", "company_domain"],
  counterparty_company_id: ["counterparty_name", "counterparty_country"], contact_id: ["contact_name", "contact_email"], stage_id: ["stage_name", "stage_color"],
  email: ["emails"], phone: ["phones"], type_id: ["type_name", "type_code", "type_color"], deal_id: ["deal_name"], parent_id: ["parent_name"], pipeline_id: ["pipeline_name"],
  amount: ["weighted_amount"],
};
/** Campos que nunca se pueden restringir (identidad del registro). */
const ALWAYS = new Set(["id", "workspace_id", "name", "first_name", "last_name", "title", "subject", "number", "created_at", "updated_at", "deleted_at"]);

export interface FieldInfo { key: string; label: string; type: string; builtin: boolean; options_ref?: string; locked?: boolean }
/** Catálogo de campos de un objeto: nativos (con su tipo) y personalizados (custom.<clave>). */
export function fieldCatalog(ctx: Ctx, object: string): FieldInfo[] {
  const builtin = builtinColumns(object).map((b) => ({ key: b.id, label: b.title, type: b.type, builtin: true, options_ref: b.type === "status" ? `${object}.${b.id}` : undefined, locked: ALWAYS.has(b.id) }));
  const custom = fieldDefs(ctx, object).map((d) => ({ key: `custom.${d.key}`, label: d.label, type: d.type, builtin: false }));
  return [...builtin, ...custom];
}

const cache = new WeakMap<Ctx, Map<string, Map<string, Access>>>();
/** Mapa campo → acceso para el rol del contexto (solo los restringidos; el resto es editable). */
export function accessMap(ctx: Ctx, object: string): Map<string, Access> {
  if (isAdmin(ctx) || !ctx.role?.id) return new Map();
  let per = cache.get(ctx); if (!per) { per = new Map(); cache.set(ctx, per); }
  let m = per.get(object);
  if (!m) {
    m = new Map(ctx.db.all<{ field: string; access: Access }>("SELECT field, access FROM field_permissions WHERE workspace_id=? AND role_id=? AND object=?", ctx.ws, ctx.role.id, object).filter((r) => !ALWAYS.has(r.field)).map((r) => [r.field, r.access]));
    per.set(object, m);
  }
  return m;
}
export const accessOf = (ctx: Ctx, object: string, field: string): Access => accessMap(ctx, object).get(field) ?? "edit";
export function clearAccessCache(ctx: Ctx) { cache.delete(ctx); }

/** Quita de un registro los campos ocultos para el rol (y sus claves derivadas). Muta y devuelve el registro. */
export function redact<T extends Row | null | undefined>(ctx: Ctx, object: string, row: T): T {
  if (!row || typeof row !== "object") return row;
  const m = accessMap(ctx, object); if (!m.size) return row;
  const r = row as Row;
  for (const [field, a] of m) {
    if (a !== "hidden") continue;
    if (field.startsWith("custom.")) { const c = r.custom as Row | undefined; if (c && typeof c === "object") delete c[field.slice(7)]; continue; }
    delete r[field];
    for (const al of ALIASES[field] ?? []) delete r[al];
  }
  return row;
}
export function redactAll<T extends Row>(ctx: Ctx, object: string, rows: T[]): T[] { if (accessMap(ctx, object).size) rows.forEach((r) => redact(ctx, object, r)); return rows; }
/** Columnas de exportación visibles para el rol. */
export function visibleColumns(ctx: Ctx, object: string, cols: string[]): string[] {
  const m = accessMap(ctx, object); if (!m.size) return cols;
  const hidden = new Set<string>(); for (const [f, a] of m) if (a === "hidden") { hidden.add(f); (ALIASES[f] ?? []).forEach((x) => hidden.add(x)); }
  return cols.filter((c) => !hidden.has(c));
}

/** Claves de campo que toca un cuerpo de escritura: { campo: v, custom: { k: v } } → ["campo", "custom.k"]. */
export function touchedFields(body: unknown, opts: { ignoreEmpty?: boolean } = {}): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const out: string[] = [];
  const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  for (const [k, v] of Object.entries(body as Row)) {
    if (k === "custom" && v && typeof v === "object") { for (const [ck, cv] of Object.entries(v as Row)) if (!ck.startsWith("_") && !(opts.ignoreEmpty && empty(cv))) out.push(`custom.${ck}`); continue; }
    if (k.startsWith("custom.")) { if (!(opts.ignoreEmpty && empty(v))) out.push(k); continue; }
    if (opts.ignoreEmpty && empty(v)) continue;
    out.push(k);
  }
  return out;
}
/** Lanza 403 si alguno de los campos es de solo lectura u oculto para el rol. */
export function assertWritable(ctx: Ctx, object: string, fields: string[]) {
  const m = accessMap(ctx, object); if (!m.size) return;
  const blocked = fields.filter((f) => { const a = m.get(f) ?? m.get(Object.entries(ALIASES).find(([, al]) => al.includes(f))?.[0] ?? ""); return a === "read" || a === "hidden"; });
  if (!blocked.length) return;
  const labels = fieldCatalog(ctx, object);
  const name = (f: string) => labels.find((x) => x.key === f)?.label ?? f;
  throw forbidden(`Tu rol no puede modificar ${blocked.length === 1 ? "el campo" : "los campos"} ${blocked.map((f) => `«${name(f)}»`).join(", ")}`);
}
/** Para informes: lanza 403 si se usa un campo oculto. */
export function assertReadable(ctx: Ctx, object: string, fields: string[]) {
  const m = accessMap(ctx, object); if (!m.size) return;
  const hidden = fields.filter((f) => f && (m.get(f) === "hidden" || m.get(Object.entries(ALIASES).find(([, al]) => al.includes(f))?.[0] ?? "") === "hidden"));
  if (hidden.length) throw forbidden(`Tu rol no tiene acceso a ${hidden.map((f) => `«${f}»`).join(", ")}`);
}
