/**
 * Diseño de fichas: secciones, orden de campos y qué aparece en la ficha, en el formulario de alta y en la vista
 * rápida; por campo: obligatorio al crear, ayuda, valor por defecto y condición de visibilidad. Cada rol puede
 * tener su propio diseño; si no, se usa el general, y si no hay ninguno se genera uno a partir de los campos.
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { id, now } from "../lib/util.js";
import { fieldCatalog, accessMap, type FieldInfo } from "./fieldSecurity.js";

export const LAYOUT_OBJECTS = ["contact", "company", "deal", "ticket", "task", "contract"] as const;
const condSchema = z.object({ field: z.string().max(80), op: z.enum(["eq", "ne", "empty", "not_empty"]).default("eq"), value: z.string().max(200).nullable().optional() });
const layoutField = z.object({ key: z.string().max(80), required: z.boolean().optional(), help: z.string().max(300).nullable().optional(), default: z.unknown().optional(), show_if: condSchema.nullable().optional() });
export const layoutSchema = z.object({
  sections: z.array(z.object({ id: z.string().max(40), title: z.string().trim().min(1).max(80), collapsed: z.boolean().optional(), columns: z.union([z.literal(1), z.literal(2)]).optional(), fields: z.array(layoutField).max(200) })).max(30),
  create: z.array(z.string().max(80)).max(200).default([]),
  quick: z.array(z.string().max(80)).max(12).default([]),
  /** los campos personalizados nuevos se añaden solos a la última sección */
  include_new: z.boolean().default(true),
});
export type Layout = z.infer<typeof layoutSchema>;

/** Campos que no tienen sentido en una ficha editable (sistema o calculados por el propio CRM). */
const SKIP = new Set(["id", "workspace_id", "deleted_at", "updated_at", "created_by", "anonymized_at", "token"]);
const CREATE_DEFAULT: Record<string, string[]> = {
  contact: ["first_name", "last_name", "email", "phone", "job_title", "company_id", "lifecycle_stage", "lead_status", "source", "owner_id"],
  company: ["name", "domain", "sector", "type", "size", "city", "country", "owner_id"],
  deal: ["name", "company_id", "amount", "expected_close_date", "owner_id", "source"],
  ticket: ["subject", "description", "contact_id", "priority", "category", "assignee_id"],
  task: ["title", "type", "due_at", "priority", "assignee_id"],
  contract: ["title", "type_id", "counterparty_company_id", "owner_id", "legal_owner_id", "end_date"],
};
const QUICK_DEFAULT: Record<string, string[]> = {
  contact: ["email", "phone", "company_id", "lifecycle_stage", "owner_id"], company: ["domain", "type", "sector", "owner_id"], deal: ["amount", "stage_id", "expected_close_date", "owner_id"],
  ticket: ["status", "priority", "assignee_id"], task: ["due_at", "priority", "assignee_id"], contract: ["status", "end_date", "owner_id"],
};

/** Diseño generado: una sección con los campos nativos y una por cada sección de campos personalizados. */
export function defaultLayout(ctx: Ctx, object: string): Layout {
  const cat = fieldCatalog(ctx, object).filter((f) => !SKIP.has(f.key));
  const builtin = cat.filter((f) => f.builtin && !["created_at", "creation_log", "last_updated"].includes(f.type) && f.key !== "created_at");
  const defs = ctx.db.all<{ key: string; section: string | null }>("SELECT key, section FROM custom_fields WHERE workspace_id=? AND object=? ORDER BY position", ctx.ws, object);
  const groups = new Map<string, string[]>();
  for (const d of defs) { const s = d.section || "Campos personalizados"; groups.set(s, [...(groups.get(s) ?? []), `custom.${d.key}`]); }
  return {
    sections: [
      { id: "main", title: "Información", fields: builtin.map((f) => ({ key: f.key })) },
      ...Array.from(groups).map(([title, keys], i) => ({ id: `s${i + 1}`, title, fields: keys.map((key) => ({ key })) })),
      { id: "system", title: "Sistema", collapsed: true, fields: [{ key: "created_at" }] },
    ],
    create: (CREATE_DEFAULT[object] ?? []).filter((k) => cat.some((f) => f.key === k)),
    quick: (QUICK_DEFAULT[object] ?? []).filter((k) => cat.some((f) => f.key === k)),
    include_new: true,
  };
}

function stored(ctx: Ctx, object: string, roleId: string | null): Layout | null {
  const r = ctx.db.get<Row>(`SELECT config FROM layouts WHERE workspace_id=? AND object=? AND ${roleId ? "role_id=?" : "role_id IS NULL"}`, ...(roleId ? [ctx.ws, object, roleId] : [ctx.ws, object]));
  if (!r) return null;
  try { return layoutSchema.parse(JSON.parse(String(r.config))); } catch { return null; }
}

/** Diseño efectivo para el rol del usuario: propio del rol → general → generado; sin campos ocultos para el rol. */
export function effectiveLayout(ctx: Ctx, object: string, roleId: string | null = ctx.role.id): { layout: Layout; source: "role" | "default" | "generated"; fields: (FieldInfo & { access: string })[] } {
  if (!LAYOUT_OBJECTS.includes(object as never)) throw badRequest("Objeto no válido");
  let source: "role" | "default" | "generated" = "role";
  let layout = roleId ? stored(ctx, object, roleId) : null;
  if (!layout) { layout = stored(ctx, object, null); source = "default"; }
  if (!layout) { layout = defaultLayout(ctx, object); source = "generated"; }
  const cat = fieldCatalog(ctx, object);
  const access = accessMap(ctx, object);
  // campos personalizados creados después de diseñar la ficha
  if (layout.include_new && layout.sections.length) {
    const placed = new Set(layout.sections.flatMap((s) => s.fields.map((f) => f.key)));
    const missing = cat.filter((f) => !f.builtin && !placed.has(f.key));
    if (missing.length) { const last = layout.sections.filter((s) => s.id !== "system").pop() ?? layout.sections[layout.sections.length - 1]!; last.fields.push(...missing.map((f) => ({ key: f.key }))); }
  }
  const known = new Set(cat.map((f) => f.key));
  const visible = (k: string) => known.has(k) && access.get(k) !== "hidden";
  layout = { ...layout, sections: layout.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => visible(f.key)) })), create: layout.create.filter(visible), quick: layout.quick.filter(visible) };
  return { layout, source, fields: cat.filter((f) => visible(f.key)).map((f) => ({ ...f, access: access.get(f.key) ?? "edit" })) };
}

export function saveLayout(ctx: Ctx, object: string, roleId: string | null, config: unknown): Layout {
  if (!LAYOUT_OBJECTS.includes(object as never)) throw badRequest("Objeto no válido");
  const layout = layoutSchema.parse(config);
  const keys = new Set(fieldCatalog(ctx, object).map((f) => f.key));
  const unknown = layout.sections.flatMap((s) => s.fields.map((f) => f.key)).filter((k) => !keys.has(k));
  if (unknown.length) throw badRequest(`Campos desconocidos: ${unknown.join(", ")}`);
  const ids = new Set<string>(); for (const s of layout.sections) { if (ids.has(s.id)) throw badRequest("Secciones con el mismo id"); ids.add(s.id); }
  const cur = ctx.db.get<Row>(`SELECT id FROM layouts WHERE workspace_id=? AND object=? AND ${roleId ? "role_id=?" : "role_id IS NULL"}`, ...(roleId ? [ctx.ws, object, roleId] : [ctx.ws, object]));
  if (cur) ctx.db.update("layouts", String(cur.id), { config: layout, updated_by: ctx.user.id, updated_at: now() });
  else ctx.db.insert("layouts", { id: id(), workspace_id: ctx.ws, object, role_id: roleId, config: layout, updated_by: ctx.user.id, updated_at: now() });
  return layout;
}
export function listLayouts(ctx: Ctx, object: string) {
  return ctx.db.all<Row>("SELECT l.id, l.role_id, l.updated_at, r.name AS role_name FROM layouts l LEFT JOIN roles r ON r.id=l.role_id WHERE l.workspace_id=? AND l.object=? ORDER BY l.role_id IS NOT NULL, r.name", ctx.ws, object).map((r) => parseJson(r, []));
}

/** Obligatorios del formulario de alta según el diseño del rol (se comprueba en el servidor al crear). */
export function assertCreateRequired(ctx: Ctx, object: string, body: Row) {
  if (!LAYOUT_OBJECTS.includes(object as never)) return;
  const { layout, fields } = effectiveLayout(ctx, object);
  const createSet = new Set(layout.create);
  const missing: string[] = [];
  for (const s of layout.sections) for (const f of s.fields) {
    if (!f.required || !createSet.has(f.key)) continue;
    if (f.show_if && !condHolds(f.show_if, body)) continue;
    const v = f.key.startsWith("custom.") ? ((body.custom as Row | undefined) ?? {})[f.key.slice(7)] : f.key === "company_id" ? body.company_id ?? body.company_name : f.key === "email" ? body.email ?? (Array.isArray(body.emails) && body.emails.length ? "x" : null) : body[f.key];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) missing.push(fields.find((x) => x.key === f.key)?.label ?? f.key);
  }
  if (missing.length) throw badRequest(`Faltan campos obligatorios: ${missing.join(", ")}`);
}
export function condHolds(c: { field: string; op?: string; value?: string | null }, rec: Row): boolean {
  const v = c.field.startsWith("custom.") ? ((rec.custom as Row | undefined) ?? {})[c.field.slice(7)] : rec[c.field];
  const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  switch (c.op ?? "eq") { case "empty": return empty; case "not_empty": return !empty; case "ne": return String(v ?? "") !== String(c.value ?? ""); default: return String(v ?? "") === String(c.value ?? ""); }
}
