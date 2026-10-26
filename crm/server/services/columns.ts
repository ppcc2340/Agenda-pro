/**
 * Modelo de celdas y columnas (manual monday, caps. 2-8 y 25):
 *  - Catálogo de tipos de columna con formato de escritura/lectura, operadores y uso en automatizaciones.
 *  - Celda = { id estable, type, value (verdad, JSON), text (presentación derivada) }.
 *  - Estados guardados por ID de etiqueta (renombrar una etiqueta no toca las celdas).
 *  - Columnas calculadas: fórmulas por fila, reflejos (mirror) con agregación declarada, autonumeración,
 *    registro de creación y última actualización. A diferencia de monday, sí disparan y condicionan automatizaciones.
 *  - Valores por defecto de tablero y columnas obligatorias por estado.
 */
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { OBJECT_FIELDS } from "../lib/filters.js";
import { isCustomObjectKey } from "../lib/objectKeys.js";

/* ------------------------------------------------------------------ catálogo de tipos */
export interface ColumnTypeDef { label: string; stores: string; write: string; read: string; filter: string[]; trigger: boolean; condition: boolean; writable: boolean; formula: boolean; schema: Record<string, unknown>; notes?: string }
const S = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
export const COLUMN_TYPES: Record<string, ColumnTypeDef> = {
  text: { label: "Texto", stores: "texto de una línea", write: '"Hola"', read: "text, value", filter: ["eq", "contains", "not_contains", "starts", "empty", "not_empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string", { maxLength: 2000 }) },
  textarea: { label: "Texto largo", stores: "texto multilínea", write: '{"text":"párrafo\\ncon saltos"} o "texto"', read: "text", filter: ["contains", "empty", "not_empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string") },
  number: { label: "Número", stores: "decimal con unidad opcional", write: '"42.5" o 42.5', read: "number, text", filter: ["eq", "gt", "gte", "lt", "lte", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("number") },
  currency: { label: "Importe", stores: "decimal en la moneda de la cuenta", write: "1200", read: "number, text", filter: ["gt", "lt", "eq"], trigger: true, condition: true, writable: true, formula: true, schema: S("number") },
  percent: { label: "Porcentaje", stores: "decimal 0-100", write: "75", read: "number, text", filter: ["gt", "lt", "eq"], trigger: true, condition: true, writable: true, formula: true, schema: S("number", { minimum: 0, maximum: 100 }) },
  status: { label: "Estado", stores: "ID de etiqueta (no el texto)", write: '{"id":2} o {"label":"Hecho"} o "Hecho"', read: "id, label, color, is_done, text", filter: ["eq", "neq", "in", "not_in", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("object", { properties: { id: { type: "integer" }, label: { type: "string" } } }), notes: "Renombrar una etiqueta cambia el texto de todas sus celdas sin tocarlas; las automatizaciones usan el ID." },
  select: { label: "Desplegable (uno)", stores: "texto de la opción", write: '"Opción A"', read: "text", filter: ["eq", "neq", "in", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string") },
  multiselect: { label: "Desplegable (varios)", stores: "lista de opciones", write: '["A","B"] o "A, B"', read: "values, text", filter: ["contains", "not_contains", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("array", { items: { type: "string" } }) },
  date: { label: "Fecha", stores: "YYYY-MM-DD", write: '"2026-10-25"', read: "date, text", filter: ["before", "after", "today", "last_days", "next_days", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string", { format: "date" }), notes: "Disparador «cuando llega la fecha» con desfase en días u horas, calculado al instante por el planificador." },
  datetime: { label: "Fecha y hora", stores: "ISO 8601 UTC", write: '"2026-10-25T14:30:00Z"', read: "date, time, text", filter: ["before", "after", "today"], trigger: true, condition: true, writable: true, formula: true, schema: S("string", { format: "date-time" }) },
  timeline: { label: "Línea temporal", stores: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}', write: '{"from":"2026-10-01","to":"2026-10-31"}', read: "from, to, text", filter: ["empty", "not_empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("object", { properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }), notes: "En fórmulas: {Columna#Start} y {Columna#End}." },
  boolean: { label: "Casilla", stores: "marcado / no", write: "true", read: "checked", filter: ["is_true", "is_false"], trigger: true, condition: true, writable: true, formula: true, schema: S("boolean") },
  rating: { label: "Valoración", stores: "entero 1..máx", write: "4", read: "rating", filter: ["eq", "gt", "lt"], trigger: true, condition: true, writable: true, formula: true, schema: S("integer", { minimum: 0, maximum: 10 }) },
  user: { label: "Persona", stores: "id de usuario", write: '"<id usuario>"', read: "id, text (nombre)", filter: ["eq", "neq", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string") },
  email: { label: "Email", stores: "dirección", write: '"a@b.com"', read: "email, text", filter: ["contains", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string", { format: "email" }) },
  phone: { label: "Teléfono", stores: "número", write: '"+34600000000"', read: "phone, text", filter: ["contains"], trigger: true, condition: true, writable: true, formula: true, schema: S("string") },
  url: { label: "Enlace", stores: "url", write: '"https://x.com"', read: "url, text", filter: ["contains", "empty"], trigger: true, condition: true, writable: true, formula: true, schema: S("string", { format: "uri" }) },
  button: { label: "Botón", stores: "nada: es un disparador manual", write: "— (POST …/button)", read: "label, color", filter: [], trigger: true, condition: false, writable: false, formula: false, schema: S("null"), notes: "«Cuando se pulsa el botón» → cualquier acción: aprobar, generar documento, enviar…" },
  formula: { label: "Fórmula", stores: "nada: se calcula por fila", write: "— (solo lectura)", read: "text, value", filter: ["eq", "gt", "lt", "contains", "empty"], trigger: true, condition: true, writable: false, formula: true, schema: S("null"), notes: "A diferencia de monday, el resultado sí dispara y condiciona automatizaciones." },
  mirror: { label: "Reflejo (mirror)", stores: "nada: valor de registros conectados agregado", write: "— (solo lectura)", read: "text, value, items", filter: ["eq", "gt", "lt", "contains", "is_true", "is_false"], trigger: true, condition: true, writable: false, formula: true, schema: S("null"), notes: "Agregaciones declaradas: suma, media, mediana, mín, máx, contar, lista, primero/último y TODOS/ALGUNO/NINGUNO = valor (usable como condición)." },
  autonumber: { label: "Autonumeración", stores: "nada: secuencia por fecha de creación", write: "— (solo lectura)", read: "text", filter: [], trigger: false, condition: true, writable: false, formula: true, schema: S("null"), notes: "No es un id estable: para referencias usa el id del registro." },
  creation_log: { label: "Registro de creación", stores: "creador y fecha (solo lectura)", write: "—", read: "created_at, creator", filter: ["before", "after", "last_days"], trigger: false, condition: true, writable: false, formula: true, schema: S("null"), notes: "Para «N días después de crear» usa el disparador de fecha sobre «created_at»: el planificador lo resuelve sin fecha auxiliar." },
  last_updated: { label: "Última actualización", stores: "fecha y usuario del último cambio (solo lectura)", write: "—", read: "updated_at, updater", filter: ["before", "after", "last_days"], trigger: false, condition: true, writable: false, formula: true, schema: S("null") },
};
export const CUSTOM_TYPES = Object.keys(COLUMN_TYPES) as [string, ...string[]];
export const COMPUTED_TYPES = ["formula", "mirror", "autonumber", "creation_log", "last_updated"];

/* ------------------------------------------------------------------ columnas nativas */
const TITLES: Record<string, string> = {
  first_name: "Nombre", last_name: "Apellidos", email: "Email", phone: "Teléfono", job_title: "Cargo", company_id: "Empresa", lifecycle_stage: "Ciclo de vida", lead_status: "Estado del lead", source: "Origen", owner_id: "Propietario", score: "Puntuación", language: "Idioma", city: "Ciudad", country: "País", consent_marketing: "Consentimiento", do_not_contact: "No contactar", tags: "Etiquetas", last_activity_at: "Última actividad", last_contacted_at: "Último contacto", created_at: "Creado", updated_at: "Actualizado", birthday: "Cumpleaños",
  name: "Nombre", domain: "Dominio", sector: "Sector", size: "Empleados", revenue: "Facturación", type: "Tipo", status: "Estado", parent_id: "Matriz",
  pipeline_id: "Pipeline", stage_id: "Etapa", amount: "Importe", currency: "Moneda", probability: "Probabilidad", expected_close_date: "Cierre previsto", closed_at: "Cerrado", loss_reason: "Motivo de pérdida", stage_entered_at: "En etapa desde", next_activity_at: "Próxima actividad",
  subject: "Asunto", description: "Descripción", priority: "Prioridad", category: "Categoría", assignee_id: "Asignado", channel: "Canal", contact_id: "Contacto", sla_due_at: "Vence SLA", resolved_at: "Resuelto", title: "Título", due_at: "Vence", completed_at: "Completada",
  number: "Número", type_id: "Tipo de contrato", counterparty_company_id: "Contraparte", deal_id: "Negocio", legal_owner_id: "Legal", department: "Departamento", kind: "Clase", paper_origin: "Papel", governing_law: "Ley aplicable", requested_at: "Solicitado", signed_at: "Firmado", effective_date: "Inicio", end_date: "Fin de vigencia", term_type: "Duración", renewal_type: "Renovación", notice_deadline: "Límite de preaviso", total_value: "Valor total", annual_value: "Valor anual", payment_model: "Modelo de pago", payment_terms_days: "Días de pago", risk_level: "Riesgo", risk_score: "Puntuación de riesgo", confidentiality: "Confidencialidad", contains_personal_data: "Datos personales", data_role: "Rol de datos", dora_in_scope: "DORA", urgency: "Urgencia", legal_hold: "Retención legal",
};
const STATUS_BUILTIN = new Set(["lifecycle_stage", "lead_status", "status", "priority", "stage_id", "type", "risk_level", "renewal_type", "paper_origin", "urgency", "source", "kind", "channel", "category"]);
const PEOPLE_BUILTIN = new Set(["owner_id", "assignee_id", "legal_owner_id"]);
export function builtinColumns(object: string): { id: string; title: string; type: string; builtin: true }[] {
  const f = OBJECT_FIELDS[object] ?? {};
  return Object.entries(f).map(([k, kind]) => ({ id: k, title: TITLES[k] ?? k, builtin: true as const, type: k === "created_at" ? "creation_log" : k === "updated_at" ? "last_updated" : STATUS_BUILTIN.has(k) ? "status" : PEOPLE_BUILTIN.has(k) ? "user" : k === "email" ? "email" : k === "phone" ? "phone" : kind === "number" ? "number" : kind === "date" ? "date" : kind === "bool" ? "boolean" : kind === "json" ? "multiselect" : "text" }));
}

/* ------------------------------------------------------------------ definiciones personalizadas */
export interface StatusLabel { id: number; label: string; color: string; done?: boolean }
export interface FieldDef { id: string; object: string; key: string; label: string; type: string; options: string[]; required: number; default_value: string | null; settings: Record<string, unknown> }
export function fieldDefs(ctx: Ctx, object: string): FieldDef[] {
  return ctx.db.all<Row>("SELECT * FROM custom_fields WHERE workspace_id=? AND object=? ORDER BY position", ctx.ws, object).map((r) => parseJson(r, ["options", "settings"]) as unknown as FieldDef).map((d) => ({ ...d, options: Array.isArray(d.options) ? d.options : [], settings: d.settings && typeof d.settings === "object" ? d.settings : {} }));
}
/** Etiquetas efectivas de una columna de estado (propias o de un conjunto compartido de la cuenta). */
export function statusLabels(ctx: Ctx, d: FieldDef): StatusLabel[] {
  const setId = d.settings.label_set_id as string | undefined;
  if (setId) {
    const set = parseJson(ctx.db.get<Row>("SELECT labels FROM label_sets WHERE id=? AND workspace_id=?", setId, ctx.ws), ["labels"]);
    if (set && Array.isArray(set.labels)) return set.labels as StatusLabel[];
  }
  const own = d.settings.labels as StatusLabel[] | undefined;
  if (Array.isArray(own) && own.length) return own;
  return d.options.map((o, i) => ({ id: i + 1, label: o, color: "#579bfc" }));
}
/** Acepta {id}, {label}, id numérico o texto de etiqueta y devuelve el id guardado. */
export function resolveStatus(labels: StatusLabel[], v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const o = typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (o?.id !== undefined) { const n = Number(o.id); if (labels.some((l) => l.id === n)) return n; }
  const txt = o ? String(o.label ?? "") : String(v);
  if (!o && /^\d+$/.test(txt) && labels.some((l) => l.id === Number(txt))) return Number(txt);
  const hit = labels.find((l) => norm(l.label) === norm(txt));
  if (hit) return hit.id;
  throw badRequest(`Etiqueta desconocida: ${txt}`);
}
export const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Normaliza el valor de entrada de un campo nuevo-tipo; null si no aplica (lo trata validateCustom). */
export function coerceCustom(ctx: Ctx, d: FieldDef, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } | null {
  if (v === null || v === undefined || v === "") return d.type in { status: 1, rating: 1, timeline: 1 } ? { ok: true, value: null } : null;
  switch (d.type) {
    case "status": try { return { ok: true, value: resolveStatus(statusLabels(ctx, d), v) }; } catch (e) { return { ok: false, error: `${d.label}: ${(e as Error).message}` }; }
    case "rating": { const max = Number(d.settings.max ?? 5); const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? { ok: true, value: n } : { ok: false, error: `${d.label}: valoración entre 0 y ${max}` }; }
    case "timeline": {
      const o = (typeof v === "string" ? safeJson(v) : v) as Record<string, unknown> | null;
      const from = String(o?.from ?? ""), to = String(o?.to ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { ok: false, error: `${d.label}: indica inicio y fin (YYYY-MM-DD)` };
      if (to < from) return { ok: false, error: `${d.label}: el fin no puede ser anterior al inicio` };
      return { ok: true, value: { from, to } };
    }
    default: if (COMPUTED_TYPES.includes(d.type) || d.type === "button") return { ok: true, value: undefined }; return null;
  }
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/* ------------------------------------------------------------------ texto derivado de una celda */
export function cellText(ctx: Ctx, type: string, v: unknown, d?: FieldDef): string {
  if (v === null || v === undefined || v === "") return "";
  switch (type) {
    case "status": { if (d) { const l = statusLabels(ctx, d).find((x) => x.id === Number(v)); return l?.label ?? String(v); } return String(v); }
    case "boolean": return v === true || v === 1 || v === "true" ? "Sí" : "No";
    case "timeline": { const o = v as { from?: string; to?: string }; return `${o.from ?? ""} – ${o.to ?? ""}`; }
    case "user": return ctx.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", v)?.name ?? String(v);
    case "multiselect": return Array.isArray(v) ? v.join(", ") : String(v);
    case "currency": return new Intl.NumberFormat("es-ES", { style: "currency", currency: ctx.settings.currency || "EUR" }).format(Number(v));
    case "percent": return `${v}%`;
    case "rating": return "★".repeat(Number(v));
    case "mirror": return Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Sí" : "No") : String(v);
    default: return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

/* ------------------------------------------------------------------ relaciones (connect + mirror) */
export interface RelationDef { label: string; target: string; many: boolean; rows: (ctx: Ctx, rec: Row) => Row[] }
const one = (ctx: Ctx, table: string, idv: unknown, json: string[] = ["tags", "custom"]) => (idv ? [parseJson(ctx.db.get<Row>(`SELECT * FROM ${table} WHERE id=?`, idv), json)].filter(Boolean) as Row[] : []);
const many = (ctx: Ctx, sql: string, json: string[], ...p: unknown[]) => ctx.db.all<Row>(sql, ...p).map((r) => parseJson(r, json) as Row);
export const RELATIONS: Record<string, Record<string, RelationDef>> = {
  contact: {
    company: { label: "Empresa", target: "company", many: false, rows: (c, r) => one(c, "companies", r.company_id) },
    deals: { label: "Negocios", target: "deal", many: true, rows: (c, r) => many(c, "SELECT d.* FROM deals d JOIN deal_contacts dc ON dc.deal_id=d.id WHERE dc.contact_id=? AND d.deleted_at IS NULL", ["tags", "custom"], r.id) },
    tasks: { label: "Tareas (subelementos)", target: "task", many: true, rows: (c, r) => many(c, "SELECT * FROM tasks WHERE contact_id=?", [], r.id) },
    tickets: { label: "Tickets", target: "ticket", many: true, rows: (c, r) => many(c, "SELECT * FROM tickets WHERE contact_id=?", ["tags"], r.id) },
  },
  company: {
    contacts: { label: "Contactos", target: "contact", many: true, rows: (c, r) => many(c, "SELECT * FROM contacts WHERE company_id=? AND deleted_at IS NULL", ["tags", "custom"], r.id) },
    deals: { label: "Negocios", target: "deal", many: true, rows: (c, r) => many(c, "SELECT * FROM deals WHERE company_id=? AND deleted_at IS NULL", ["tags", "custom"], r.id) },
    contracts: { label: "Contratos", target: "contract", many: true, rows: (c, r) => many(c, "SELECT * FROM contracts WHERE counterparty_company_id=? AND deleted_at IS NULL", ["tags", "custom"], r.id) },
    tickets: { label: "Tickets", target: "ticket", many: true, rows: (c, r) => many(c, "SELECT * FROM tickets WHERE company_id=?", ["tags"], r.id) },
    tasks: { label: "Tareas (subelementos)", target: "task", many: true, rows: (c, r) => many(c, "SELECT * FROM tasks WHERE company_id=?", [], r.id) },
    parent: { label: "Empresa matriz", target: "company", many: false, rows: (c, r) => one(c, "companies", r.parent_id) },
  },
  deal: {
    company: { label: "Empresa", target: "company", many: false, rows: (c, r) => one(c, "companies", r.company_id) },
    contacts: { label: "Contactos", target: "contact", many: true, rows: (c, r) => many(c, "SELECT c.* FROM contacts c JOIN deal_contacts dc ON dc.contact_id=c.id WHERE dc.deal_id=?", ["tags", "custom"], r.id) },
    tasks: { label: "Tareas (subelementos)", target: "task", many: true, rows: (c, r) => many(c, "SELECT * FROM tasks WHERE deal_id=?", [], r.id) },
    contracts: { label: "Contratos", target: "contract", many: true, rows: (c, r) => many(c, "SELECT * FROM contracts WHERE deal_id=? AND deleted_at IS NULL", ["tags", "custom"], r.id) },
    products: { label: "Líneas de producto", target: "deal_product", many: true, rows: (c, r) => many(c, "SELECT dp.*, dp.quantity*dp.unit_price*(1-COALESCE(dp.discount,0)/100.0) AS total FROM deal_products dp WHERE dp.deal_id=?", [], r.id) },
  },
  ticket: {
    contact: { label: "Contacto", target: "contact", many: false, rows: (c, r) => one(c, "contacts", r.contact_id, ["tags", "custom"]) },
    company: { label: "Empresa", target: "company", many: false, rows: (c, r) => one(c, "companies", r.company_id) },
    tasks: { label: "Tareas (subelementos)", target: "task", many: true, rows: (c, r) => many(c, "SELECT * FROM tasks WHERE ticket_id=?", [], r.id) },
  },
  contract: {
    company: { label: "Contraparte", target: "company", many: false, rows: (c, r) => one(c, "companies", r.counterparty_company_id) },
    deal: { label: "Negocio", target: "deal", many: false, rows: (c, r) => one(c, "deals", r.deal_id) },
    obligations: { label: "Obligaciones (subelementos)", target: "obligation", many: true, rows: (c, r) => many(c, "SELECT * FROM obligations WHERE contract_id=?", [], r.id) },
    milestones: { label: "Hitos", target: "milestone", many: true, rows: (c, r) => many(c, "SELECT * FROM milestones WHERE contract_id=?", [], r.id) },
    payments: { label: "Calendario de pagos", target: "payment", many: true, rows: (c, r) => many(c, "SELECT * FROM payment_schedule WHERE contract_id=?", [], r.id) },
    amendments: { label: "Enmiendas y renovaciones", target: "contract", many: true, rows: (c, r) => many(c, "SELECT * FROM contracts WHERE parent_id=? AND deleted_at IS NULL", ["tags", "custom"], r.id) },
    parent: { label: "Contrato principal", target: "contract", many: false, rows: (c, r) => one(c, "contracts", r.parent_id) },
  },
};
/** Proveedores de relaciones dinámicas (objetos personalizados) que se suman a las nativas. */
type RelationProvider = (ctx: Ctx, object: string) => Record<string, RelationDef>;
const relationProviders: RelationProvider[] = [];
export function registerRelationProvider(p: RelationProvider) { if (!relationProviders.includes(p)) relationProviders.push(p); }
/** Relaciones de un objeto: las nativas más las de objetos personalizados (propias e inversas). */
export function relationsFor(ctx: Ctx, object: string): Record<string, RelationDef> {
  const out: Record<string, RelationDef> = { ...(RELATIONS[object] ?? {}) };
  for (const p of relationProviders) Object.assign(out, p(ctx, object));
  return out;
}
/** Campos útiles de los objetos destino que no están en OBJECT_FIELDS. */
export const EXTRA_TARGET_FIELDS: Record<string, string[]> = {
  task: ["title", "type", "priority", "assignee_id", "due_at", "completed_at", "done"],
  obligation: ["title", "type", "status", "due_date", "amount", "owner_id", "fulfilled_at"],
  milestone: ["type", "label", "date", "status"],
  payment: ["label", "due_date", "amount", "status", "paid_at"],
  deal_product: ["name", "quantity", "unit_price", "discount", "total"],
};
export const AGGREGATIONS: Record<string, string> = { sum: "Suma", avg: "Media", median: "Mediana", min: "Mínimo", max: "Máximo", count: "Contar", count_not_empty: "Contar no vacíos", list: "Lista", list_unique: "Lista sin repetidos", first: "Primero", earliest: "Fecha más temprana", latest: "Fecha más tardía", all_eq: "TODOS = valor", any_eq: "ALGUNO = valor", none_eq: "NINGUNO = valor", pct_eq: "% = valor (progreso)" };

export function aggregate(values: unknown[], agg: string, cmp?: unknown): unknown {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
  const nums = nonEmpty.map(Number).filter((n) => !Number.isNaN(n));
  const eq = (v: unknown) => norm(v) === norm(cmp);
  switch (agg) {
    case "sum": return round2(nums.reduce((a, b) => a + b, 0));
    case "avg": return nums.length ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    case "median": { if (!nums.length) return null; const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : round2((s[m - 1]! + s[m]!) / 2); }
    case "min": return nums.length ? Math.min(...nums) : null;
    case "max": return nums.length ? Math.max(...nums) : null;
    case "count": return values.length;
    case "count_not_empty": return nonEmpty.length;
    case "list": return nonEmpty.map(String);
    case "list_unique": return [...new Set(nonEmpty.map(String))];
    case "first": return nonEmpty[0] ?? null;
    case "earliest": return nonEmpty.map(String).sort()[0] ?? null;
    case "latest": return nonEmpty.map(String).sort().slice(-1)[0] ?? null;
    case "all_eq": return values.length > 0 && values.every(eq);
    case "any_eq": return values.some(eq);
    case "none_eq": return !values.some(eq);
    case "pct_eq": return values.length ? Math.round((100 * values.filter(eq).length) / values.length) : 0;
    default: return null;
  }
}
const round2 = (n: number) => Math.round(n * 100) / 100;
function targetValue(row: Row, field: string): unknown {
  if (field === "done") return row.completed_at ? "true" : "false";
  if (field.startsWith("custom.")) return (row.custom as Record<string, unknown> | undefined)?.[field.slice(7)];
  return row[field];
}
export function mirrorValue(ctx: Ctx, object: string, rec: Row, s: Record<string, unknown>): { value: unknown; items: { id: unknown; value: unknown }[] } {
  const rel = relationsFor(ctx, object)[String(s.relation ?? "")];
  if (!rel) return { value: null, items: [] };
  const rows = rel.rows(ctx, rec);
  const field = String(s.field ?? "id");
  const items = rows.map((r) => ({ id: r.id, value: targetValue(r, field) }));
  return { value: aggregate(items.map((i) => i.value), String(s.agg ?? (rel.many ? "list" : "first")), s.compare), items };
}

/* ------------------------------------------------------------------ motor de fórmulas */
type Tok = { t: "num" | "str" | "ref" | "id" | "op" | "(" | ")" | ","; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < src.length && /[0-9.]/.test(src[j]!)) j++; out.push({ t: "num", v: src.slice(i, j) }); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ""; while (j < src.length && src[j] !== c) { s += src[j]; j++; } if (j >= src.length) throw new Error("Comillas sin cerrar"); out.push({ t: "str", v: s }); i = j + 1; continue; }
    if (c === "{") { const j = src.indexOf("}", i); if (j < 0) throw new Error("Llave sin cerrar"); out.push({ t: "ref", v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++; out.push({ t: "id", v: src.slice(i, j).toUpperCase() }); i = j; continue; }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "=="].includes(two)) { out.push({ t: "op", v: two === "==" ? "=" : two === "!=" ? "<>" : two }); i += 2; continue; }
    if ("+-*/^&=<>".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c, v: c }); i++; continue; }
    if (c === ";") { out.push({ t: ",", v: "," }); i++; continue; }
    throw new Error(`Carácter no válido: ${c}`);
  }
  return out;
}
type Node = { k: "num"; v: number } | { k: "str"; v: string } | { k: "bool"; v: boolean } | { k: "ref"; v: string } | { k: "call"; f: string; a: Node[] } | { k: "bin"; op: string; l: Node; r: Node } | { k: "neg"; e: Node };
function parse(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const eat = (t?: string) => { const x = toks[p++]; if (!x || (t && x.t !== t && x.v !== t)) throw new Error(t ? `Se esperaba «${t}»` : "Fórmula incompleta"); return x; };
  const prec: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };
  const primary = (): Node => {
    const x = peek(); if (!x) throw new Error("Fórmula incompleta");
    if (x.t === "op" && x.v === "-") { p++; return { k: "neg", e: unary() }; }
    if (x.t === "op" && x.v === "+") { p++; return unary(); }
    if (x.t === "num") { p++; const n = Number(x.v); if (Number.isNaN(n)) throw new Error(`Número no válido: ${x.v}`); return { k: "num", v: n }; }
    if (x.t === "str") { p++; return { k: "str", v: x.v }; }
    if (x.t === "ref") { p++; return { k: "ref", v: x.v }; }
    if (x.t === "(") { p++; const e = expr(0); eat(")"); return e; }
    if (x.t === "id") {
      p++;
      if (x.v === "TRUE" || x.v === "FALSE") { if (peek()?.t === "(") { p++; eat(")"); } return { k: "bool", v: x.v === "TRUE" }; }
      eat("(");
      const a: Node[] = [];
      if (peek()?.t !== ")") { a.push(expr(0)); while (peek()?.t === ",") { p++; a.push(expr(0)); } }
      eat(")");
      return { k: "call", f: x.v, a };
    }
    throw new Error(`Token inesperado: ${x.v}`);
  };
  const unary = (): Node => primary();
  const expr = (min: number): Node => {
    let l = unary();
    for (;;) { const x = peek(); if (!x || x.t !== "op" || (prec[x.v] ?? 0) <= min - 1 || (prec[x.v] ?? 0) < min) break; const pr = prec[x.v]!; p++; const r = expr(x.v === "^" ? pr : pr + 1); l = { k: "bin", op: x.v, l, r }; }
    return l;
  };
  const e = expr(0);
  if (p < toks.length) throw new Error(`Sobra «${toks[p]!.v}»`);
  return e;
}
const toNum = (v: unknown) => { if (v === null || v === undefined || v === "") return 0; if (typeof v === "boolean") return v ? 1 : 0; const n = Number(v); if (Number.isNaN(n)) throw new Error(`«${String(v)}» no es un número`); return n; };
const toStr = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : Array.isArray(v) ? v.join(", ") : String(v));
const truthy = (v: unknown) => !(v === false || v === 0 || v === null || v === undefined || v === "" || v === "FALSE" || v === "false");
const toDate = (v: unknown): Date => { const s = toStr(v); if (!s) throw new Error("Fecha vacía"); const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s); if (Number.isNaN(d.getTime())) throw new Error(`«${s}» no es una fecha`); return d; };
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function addBusinessDays(from: Date, n: number): Date { const d = new Date(from); const step = n < 0 ? -1 : 1; let left = Math.abs(n); while (left > 0) { d.setUTCDate(d.getUTCDate() + step); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) left--; } return d; }
function workdays(a: Date, b: Date): number { let s = new Date(Math.min(a.getTime(), b.getTime())), e = new Date(Math.max(a.getTime(), b.getTime())), n = 0; while (s <= e) { const wd = s.getUTCDay(); if (wd !== 0 && wd !== 6) n++; s = new Date(s.getTime() + 86400000); } return a > b ? n : -n; }
function fmtDate(d: Date, f: string) { const p = (n: number) => String(n).padStart(2, "0"); return f.replace("YYYY", String(d.getUTCFullYear())).replace("MM", p(d.getUTCMonth() + 1)).replace("DD", p(d.getUTCDate())).replace("HH", p(d.getUTCHours())).replace("mm", p(d.getUTCMinutes())); }
export const FORMULA_FUNCTIONS: Record<string, { sig: string; desc: string; family: string }> = {
  IF: { sig: "IF(cond, si, no)", desc: "Condicional", family: "Lógica" }, AND: { sig: "AND(a, b, …)", desc: "Todas ciertas", family: "Lógica" }, OR: { sig: "OR(a, b, …)", desc: "Alguna cierta", family: "Lógica" }, NOT: { sig: "NOT(a)", desc: "Negación", family: "Lógica" }, XOR: { sig: "XOR(a, b)", desc: "Exactamente una", family: "Lógica" }, SWITCH: { sig: "SWITCH(v, caso1, res1, …, defecto)", desc: "Selección por casos", family: "Lógica" }, EXACT: { sig: "EXACT(a, b)", desc: "Igualdad exacta de texto", family: "Lógica" }, ISBLANK: { sig: "ISBLANK(v)", desc: "Vacío", family: "Lógica" },
  SUM: { sig: "SUM(a, b, …)", desc: "Suma", family: "Números" }, AVERAGE: { sig: "AVERAGE(a, …)", desc: "Media", family: "Números" }, MIN: { sig: "MIN(a, …)", desc: "Mínimo", family: "Números" }, MAX: { sig: "MAX(a, …)", desc: "Máximo", family: "Números" }, COUNT: { sig: "COUNT(a, …)", desc: "Cuenta valores no vacíos", family: "Números" }, ROUND: { sig: "ROUND(n, dec)", desc: "Redondeo", family: "Números" }, ROUNDUP: { sig: "ROUNDUP(n, dec)", desc: "Redondeo hacia arriba", family: "Números" }, ROUNDDOWN: { sig: "ROUNDDOWN(n, dec)", desc: "Redondeo hacia abajo", family: "Números" }, ABS: { sig: "ABS(n)", desc: "Valor absoluto", family: "Números" }, MOD: { sig: "MOD(n, d)", desc: "Resto", family: "Números" }, POWER: { sig: "POWER(n, e)", desc: "Potencia", family: "Números" }, SQRT: { sig: "SQRT(n)", desc: "Raíz cuadrada", family: "Números" }, LOG: { sig: "LOG(n, base)", desc: "Logaritmo", family: "Números" }, MINUS: { sig: "MINUS(a, b)", desc: "Resta", family: "Números" }, MULTIPLY: { sig: "MULTIPLY(a, b)", desc: "Multiplica", family: "Números" }, DIVIDE: { sig: "DIVIDE(a, b)", desc: "Divide (0 si b = 0)", family: "Números" },
  CONCATENATE: { sig: "CONCATENATE(a, b, …)", desc: "Une textos", family: "Texto" }, LEN: { sig: "LEN(t)", desc: "Longitud", family: "Texto" }, LEFT: { sig: "LEFT(t, n)", desc: "Izquierda", family: "Texto" }, RIGHT: { sig: "RIGHT(t, n)", desc: "Derecha", family: "Texto" }, MID: { sig: "MID(t, inicio, n)", desc: "Subcadena", family: "Texto" }, UPPER: { sig: "UPPER(t)", desc: "Mayúsculas", family: "Texto" }, LOWER: { sig: "LOWER(t)", desc: "Minúsculas", family: "Texto" }, TRIM: { sig: "TRIM(t)", desc: "Quita espacios", family: "Texto" }, SUBSTITUTE: { sig: "SUBSTITUTE(t, viejo, nuevo)", desc: "Reemplaza", family: "Texto" }, REPLACE: { sig: "REPLACE(t, inicio, n, nuevo)", desc: "Reemplaza por posición", family: "Texto" }, REPT: { sig: "REPT(t, n)", desc: "Repite", family: "Texto" }, SEARCH: { sig: "SEARCH(buscar, t)", desc: "Posición (0 si no)", family: "Texto" }, TEXT: { sig: 'TEXT(v, "0.00")', desc: "Formatea número o fecha", family: "Texto" },
  TODAY: { sig: "TODAY()", desc: "Hoy", family: "Fechas" }, NOW: { sig: "NOW()", desc: "Ahora", family: "Fechas" }, DATE: { sig: "DATE(a, m, d)", desc: "Construye fecha", family: "Fechas" }, DAYS: { sig: "DAYS(fin, inicio)", desc: "Días entre fechas", family: "Fechas" }, WORKDAYS: { sig: "WORKDAYS(fin, inicio)", desc: "Días laborables", family: "Fechas" }, ADD_DAYS: { sig: "ADD_DAYS(f, n)", desc: "Suma días", family: "Fechas" }, SUBTRACT_DAYS: { sig: "SUBTRACT_DAYS(f, n)", desc: "Resta días", family: "Fechas" }, ADD_WORKDAYS: { sig: "ADD_WORKDAYS(f, n)", desc: "Suma días laborables", family: "Fechas" }, FORMAT_DATE: { sig: 'FORMAT_DATE(f, "DD/MM/YYYY")', desc: "Formatea fecha", family: "Fechas" }, YEAR: { sig: "YEAR(f)", desc: "Año", family: "Fechas" }, MONTH: { sig: "MONTH(f)", desc: "Mes", family: "Fechas" }, DAY: { sig: "DAY(f)", desc: "Día", family: "Fechas" }, WEEKNUM: { sig: "WEEKNUM(f)", desc: "Semana del año", family: "Fechas" }, HOURS_DIFF: { sig: "HOURS_DIFF(a, b)", desc: "Horas entre dos instantes", family: "Fechas" },
};
function call(f: string, a: unknown[]): unknown {
  const n = (i: number) => toNum(a[i]); const s = (i: number) => toStr(a[i]);
  const nums = () => a.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x) => x !== null && x !== undefined && x !== "").map(toNum);
  switch (f) {
    case "IF": return truthy(a[0]) ? a[1] : a[2] ?? "";
    case "AND": return a.every(truthy); case "OR": return a.some(truthy); case "NOT": return !truthy(a[0]); case "XOR": return a.filter(truthy).length === 1;
    case "SWITCH": { for (let i = 1; i + 1 < a.length; i += 2) if (toStr(a[0]) === toStr(a[i])) return a[i + 1]; return a.length % 2 === 0 ? a[a.length - 1] : ""; }
    case "EXACT": return s(0) === s(1); case "ISBLANK": return a[0] === null || a[0] === undefined || a[0] === "" || (Array.isArray(a[0]) && !a[0].length);
    case "SUM": return round2(nums().reduce((x, y) => x + y, 0)); case "AVERAGE": { const v = nums(); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; }
    case "MIN": { const v = nums(); return v.length ? Math.min(...v) : 0; } case "MAX": { const v = nums(); return v.length ? Math.max(...v) : 0; } case "COUNT": return nums().length;
    case "ROUND": { const d = Math.pow(10, n(1)); return Math.round(n(0) * d) / d; } case "ROUNDUP": { const d = Math.pow(10, n(1)); return Math.ceil(n(0) * d) / d; } case "ROUNDDOWN": { const d = Math.pow(10, n(1)); return Math.floor(n(0) * d) / d; }
    case "ABS": return Math.abs(n(0)); case "MOD": return n(0) % n(1); case "POWER": return Math.pow(n(0), n(1)); case "SQRT": return Math.sqrt(n(0)); case "LOG": return Math.log(n(0)) / Math.log(a[1] === undefined ? 10 : n(1));
    case "MINUS": return n(0) - n(1); case "MULTIPLY": return n(0) * n(1); case "DIVIDE": return n(1) === 0 ? 0 : n(0) / n(1);
    case "CONCATENATE": return a.map(toStr).join(""); case "LEN": return s(0).length; case "LEFT": return s(0).slice(0, n(1)); case "RIGHT": return n(1) ? s(0).slice(-n(1)) : ""; case "MID": return s(0).substr(n(1) - 1, n(2));
    case "UPPER": return s(0).toUpperCase(); case "LOWER": return s(0).toLowerCase(); case "TRIM": return s(0).trim(); case "SUBSTITUTE": return s(0).split(s(1)).join(s(2)); case "REPLACE": return s(0).slice(0, n(1) - 1) + s(3) + s(0).slice(n(1) - 1 + n(2)); case "REPT": return s(0).repeat(Math.max(0, n(1))); case "SEARCH": return s(1).toLowerCase().indexOf(s(0).toLowerCase()) + 1;
    case "TEXT": { const fmt = s(1); if (/YYYY|DD/.test(fmt)) return fmtDate(toDate(a[0]), fmt); const dec = (fmt.split(".")[1] ?? "").length; return fmt.includes(",") ? new Intl.NumberFormat("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n(0)) : n(0).toFixed(dec); }
    case "TODAY": return iso(new Date()); case "NOW": return new Date().toISOString(); case "DATE": return iso(new Date(Date.UTC(n(0), n(1) - 1, n(2))));
    case "DAYS": return Math.round((toDate(a[0]).getTime() - toDate(a[1]).getTime()) / 86400000); case "WORKDAYS": return workdays(toDate(a[0]), toDate(a[1]));
    case "ADD_DAYS": return iso(new Date(toDate(a[0]).getTime() + n(1) * 86400000)); case "SUBTRACT_DAYS": return iso(new Date(toDate(a[0]).getTime() - n(1) * 86400000)); case "ADD_WORKDAYS": return iso(addBusinessDays(toDate(a[0]), n(1)));
    case "FORMAT_DATE": return fmtDate(toDate(a[0]), a[1] === undefined ? "DD/MM/YYYY" : s(1)); case "YEAR": return toDate(a[0]).getUTCFullYear(); case "MONTH": return toDate(a[0]).getUTCMonth() + 1; case "DAY": return toDate(a[0]).getUTCDate();
    case "WEEKNUM": { const d = toDate(a[0]); const start = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.ceil(((d.getTime() - start) / 86400000 + new Date(start).getUTCDay() + 1) / 7); }
    case "HOURS_DIFF": return round2((toDate(a[0]).getTime() - toDate(a[1]).getTime()) / 3600000);
    default: throw new Error(`Función desconocida: ${f}`);
  }
}
function evalNode(node: Node, ref: (name: string) => unknown): unknown {
  switch (node.k) {
    case "num": case "str": case "bool": return node.v;
    case "ref": return ref(node.v);
    case "neg": return -toNum(evalNode(node.e, ref));
    case "call": {
      if (node.f === "IF") { const c = evalNode(node.a[0]!, ref); return truthy(c) ? evalNode(node.a[1]!, ref) : node.a[2] ? evalNode(node.a[2], ref) : ""; }
      return call(node.f, node.a.map((x) => evalNode(x, ref)));
    }
    case "bin": {
      const l = evalNode(node.l, ref), r = evalNode(node.r, ref);
      switch (node.op) {
        case "+": return toNum(l) + toNum(r); case "-": return toNum(l) - toNum(r); case "*": return toNum(l) * toNum(r); case "/": return toNum(r) === 0 ? 0 : toNum(l) / toNum(r); case "^": return Math.pow(toNum(l), toNum(r)); case "&": return toStr(l) + toStr(r);
        case "=": return cmp(l, r) === 0; case "<>": return cmp(l, r) !== 0; case "<": return cmp(l, r) < 0; case ">": return cmp(l, r) > 0; case "<=": return cmp(l, r) <= 0; case ">=": return cmp(l, r) >= 0;
      }
    }
  }
  return null;
}
function cmp(a: unknown, b: unknown): number { const na = Number(a), nb = Number(b); if (a !== "" && b !== "" && a !== null && b !== null && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== "boolean") return na - nb; if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b) ? 0 : 1; return norm(a).localeCompare(norm(b)); }
const PARSE_CACHE = new Map<string, Node>();
export function compileFormula(expr: string): Node { let n = PARSE_CACHE.get(expr); if (!n) { n = parse(tokenize(expr)); if (PARSE_CACHE.size > 500) PARSE_CACHE.clear(); PARSE_CACHE.set(expr, n); } return n; }
/** Referencias {…} de una fórmula (para dependencias y avisos al borrar columnas). */
export function formulaRefs(expr: string): string[] { try { return tokenize(expr).filter((t) => t.t === "ref").map((t) => t.v.split("#")[0]!); } catch { return []; } }
export function evalFormula(expr: string, ref: (name: string) => unknown): { value: unknown; error?: string } {
  try { const v = evalNode(compileFormula(expr), ref); return { value: typeof v === "number" ? (Number.isFinite(v) ? round2(v * 1e6) / 1e6 : null) : v }; } catch (e) { return { value: null, error: (e as Error).message }; }
}

/* ------------------------------------------------------------------ valores calculados */
/** Resuelve un nombre {…} a un valor: clave o título de campo personalizado, o clave/título de columna nativa. */
function resolver(ctx: Ctx, object: string, rec: Row, defs: FieldDef[], computed: Record<string, unknown>) {
  const builtins = builtinColumns(object);
  return (raw: string) => {
    const [name, part] = raw.split("#");
    const n = norm(name);
    const d = defs.find((x) => norm(x.key) === n || norm(x.label) === n);
    let v: unknown;
    if (d) {
      v = d.key in computed ? computed[d.key] : (rec.custom as Record<string, unknown> | undefined)?.[d.key];
      if (d.type === "status") v = cellText(ctx, "status", v, d);
      if (d.type === "timeline" && v && typeof v === "object") v = norm(part) === "end" ? (v as Row).to : norm(part) === "start" ? (v as Row).from : `${(v as Row).from} – ${(v as Row).to}`;
      if (d.type === "boolean") v = v === true || v === 1 || v === "true";
      return v ?? "";
    }
    const b = builtins.find((x) => norm(x.id) === n || norm(x.title) === n) ?? (n === "id" ? { id: "id" } : n in rec ? { id: name! } : null);
    if (b) { v = rec[b.id]; if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = v.slice(0, 10); return v ?? ""; }
    throw new Error(`Columna desconocida: {${name}}`);
  };
}
export interface ComputedOpts { autonumber?: Map<string, number> }
/** Rellena record.custom con los valores calculados (fórmula, reflejo, autonumeración, registros). Devuelve también errores por campo. */
export function computeFields(ctx: Ctx, object: string, rec: Row, defs = fieldDefs(ctx, object), opts: ComputedOpts = {}): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {}, errors: Record<string, string> = {};
  const comp = defs.filter((d) => COMPUTED_TYPES.includes(d.type));
  if (!comp.length) return { values, errors };
  for (const d of comp.filter((x) => x.type !== "formula")) {
    if (d.type === "mirror") { try { values[d.key] = mirrorValue(ctx, object, rec, d.settings).value; } catch (e) { errors[d.key] = (e as Error).message; values[d.key] = null; } }
    if (d.type === "creation_log") values[d.key] = rec.created_at ?? null;
    if (d.type === "last_updated") values[d.key] = rec.updated_at ?? null;
    if (d.type === "autonumber") { const pos = opts.autonumber?.get(String(rec.id)) ?? autonumberOf(ctx, object, rec); values[d.key] = pos ? `${String(d.settings.prefix ?? "")}${String(pos).padStart(Number(d.settings.pad ?? 0), "0")}` : null; }
  }
  // fórmulas en orden de dependencias (una fórmula puede usar otra); ciclo => error
  const pending = comp.filter((x) => x.type === "formula");
  const ref = resolver(ctx, object, rec, defs, values);
  for (let pass = 0; pending.length && pass < 10; pass++) {
    for (let i = 0; i < pending.length; i++) {
      const d = pending[i]!;
      const deps = formulaRefs(String(d.settings.expression ?? "")).map(norm);
      const waiting = pending.some((o) => o !== d && (deps.includes(norm(o.key)) || deps.includes(norm(o.label))));
      if (waiting && pass < 9) continue;
      const r = evalFormula(String(d.settings.expression ?? ""), ref);
      if (r.error) errors[d.key] = waiting ? "Referencia circular entre fórmulas" : r.error;
      values[d.key] = r.error ? null : castResult(r.value, String(d.settings.result ?? "auto"));
      pending.splice(i, 1); i--;
    }
  }
  return { values, errors };
}
function castResult(v: unknown, kind: string): unknown { if (v === null || v === undefined) return null; if (kind === "number") { const n = Number(v); return Number.isNaN(n) ? null : n; } if (kind === "text") return toStr(v); if (kind === "boolean") return truthy(v); return typeof v === "boolean" ? v : v; }
const TABLE: Record<string, string> = { contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", contract: "contracts", task: "tasks" };
function autonumberOf(ctx: Ctx, object: string, rec: Row): number | null { if (isCustomObjectKey(object)) { if (!rec.created_at) return null; return (ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_records WHERE workspace_id=? AND object_key=? AND (created_at < ? OR (created_at = ? AND id <= ?))", ctx.ws, object, rec.created_at, rec.created_at, rec.id)?.n ?? 0) || null; } const t = TABLE[object]; if (!t || !rec.created_at) return null; return (ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE workspace_id=? AND (created_at < ? OR (created_at = ? AND id <= ?))`, ctx.ws, rec.created_at, rec.created_at, rec.id)?.n ?? 0) || null; }
/** Enriquecer una lista (tablero) con los valores calculados. */
export function enrichList(ctx: Ctx, object: string, items: Row[]): Row[] {
  const defs = fieldDefs(ctx, object);
  if (!defs.some((d) => COMPUTED_TYPES.includes(d.type)) || !items.length) return items;
  let auto: Map<string, number> | undefined;
  if (defs.some((d) => d.type === "autonumber") && (TABLE[object] || isCustomObjectKey(object))) { auto = new Map(); (isCustomObjectKey(object) ? ctx.db.all<{ id: string }>("SELECT id FROM custom_records WHERE workspace_id=? AND object_key=? ORDER BY created_at, id", ctx.ws, object) : ctx.db.all<{ id: string }>(`SELECT id FROM ${TABLE[object]} WHERE workspace_id=? ORDER BY created_at, id`, ctx.ws)).forEach((r, i) => auto!.set(r.id, i + 1)); }
  for (const it of items) { const { values, errors } = computeFields(ctx, object, it, defs, { autonumber: auto }); it.custom = { ...((it.custom as Row) ?? {}), ...values }; if (Object.keys(errors).length) it._computed_errors = errors; }
  return items;
}
export function enrichOne<T extends Row>(ctx: Ctx, object: string, rec: T): T { if (!rec) return rec; enrichList(ctx, object, [rec]); return rec; }

/* ------------------------------------------------------------------ celdas */
interface ExtraLabel { id: string; label: string; color: string; base: string }
/** Etiqueta añadida en el tablero a una columna de estado del sistema; solo cuenta si su estado base coincide. */
export function sublabel(cfg: Row, field: string, value: unknown, custom: Row): ExtraLabel | null {
  const sid = custom[`_lbl_${field}`]; if (!sid) return null;
  const x = ((cfg.extra_labels as Record<string, ExtraLabel[]> | undefined)?.[field] ?? []).find((l) => l.id === sid);
  return x && x.base === String(value ?? "") ? x : null;
}
/** Texto visible de una celda de estado del sistema: subetiqueta, etiqueta renombrada en el tablero o valor. */
export function builtinLabel(cfg: Row, field: string, value: unknown, custom: Row): string {
  if (value === null || value === undefined || value === "") return "";
  const s = sublabel(cfg, field, value, custom); if (s) return s.label;
  return ((cfg.labels as Record<string, Record<string, { label?: string }>> | undefined)?.[field]?.[String(value)]?.label) ?? String(value);
}
export function cellsOf(ctx: Ctx, object: string, rec: Row) {
  const defs = fieldDefs(ctx, object);
  enrichOne(ctx, object, rec);
  const custom = (rec.custom as Row) ?? {};
  const cfg = boardConfig(ctx, object);
  // estados de un objeto personalizado: se guardan por id y se muestran con la etiqueta de su definición
  const objStatuses = isCustomObjectKey(object) ? ((parseJson(ctx.db.get<Row>("SELECT statuses FROM custom_objects WHERE workspace_id=? AND key=?", ctx.ws, object), ["statuses"])?.statuses as StatusLabel[] | undefined) ?? []) : null;
  return [
    ...builtinColumns(object).map((b) => ({ id: b.id, title: b.title, type: b.type, value: rec[b.id] ?? null, text: objStatuses && b.id === "status" ? (objStatuses.find((s) => String(s.id) === String(rec.status))?.label ?? "") : b.type === "status" ? builtinLabel(cfg, b.id, rec[b.id], custom) : cellText(ctx, b.type, rec[b.id]), builtin: true, ...(b.type === "status" && sublabel(cfg, b.id, rec[b.id], custom) ? { sublabel: sublabel(cfg, b.id, rec[b.id], custom)!.id } : {}) })),
    ...defs.map((d) => {
      const v = custom[d.key] ?? null;
      const extra = d.type === "status" ? (() => { const l = statusLabels(ctx, d).find((x) => x.id === Number(v)); return { label: l?.label ?? null, color: l?.color ?? null, is_done: !!l?.done }; })() : d.type === "button" ? { label: d.settings.label ?? d.label, color: d.settings.color ?? null } : {};
      return { id: `custom.${d.key}`, title: d.label, type: d.type, value: v, text: cellText(ctx, d.type, v, d), builtin: false, ...extra };
    }),
  ];
}

/* ------------------------------------------------------------------ valores por defecto y obligatorias */
export interface RequiredRule { when_field: string; values: string[]; fields: string[] }
export function boardConfig(ctx: Ctx, object: string): Row { const r = ctx.db.get<{ config: string }>("SELECT config FROM board_configs WHERE workspace_id=? AND object=?", ctx.ws, object); try { return r ? JSON.parse(r.config) : {}; } catch { return {}; } }
/** Valores por defecto del tablero: el registro nace con ellos (no generan evento de cambio ni gastan acciones). */
export function applyDefaults<T extends Record<string, unknown>>(ctx: Ctx, object: string, input: T): T {
  const defaults = (boardConfig(ctx, object).defaults ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (v === null || v === undefined || v === "") continue;
    const val = v === "@me" ? ctx.user.id : v === "@today" ? new Date().toISOString().slice(0, 10) : v;
    if (k.startsWith("custom.")) { const c = { ...((out.custom as Row) ?? {}) }; if (c[k.slice(7)] === undefined || c[k.slice(7)] === null || c[k.slice(7)] === "") c[k.slice(7)] = val; out.custom = c; }
    else if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = val;
  }
  return out as T;
}
/** Columnas obligatorias por estado: impide pasar a ciertos valores si faltan datos. */
export function checkRequired(ctx: Ctx, object: string, prev: Row, next: Row) {
  const rules = (boardConfig(ctx, object).required ?? []) as RequiredRule[];
  if (!rules.length) return;
  const get = (r: Row, f: string) => (f.startsWith("custom.") ? (r.custom as Row | undefined)?.[f.slice(7)] : r[f]);
  const merged: Row = { ...prev, ...next, custom: { ...((prev.custom as Row) ?? {}), ...((next.custom as Row) ?? {}) } };
  const missing: string[] = [];
  for (const rule of rules) {
    const before = String(get(prev, rule.when_field) ?? ""), after = String(get(merged, rule.when_field) ?? "");
    if (before === after || !rule.values.map(String).includes(after)) continue;
    for (const f of rule.fields) { const v = get(merged, f); if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) missing.push(f); }
  }
  if (missing.length) {
    const defs = fieldDefs(ctx, object);
    const title = (f: string) => (f.startsWith("custom.") ? defs.find((d) => d.key === f.slice(7))?.label : TITLES[f]) ?? f;
    throw badRequest(`Faltan columnas obligatorias para ese estado: ${[...new Set(missing)].map(title).join(", ")}`, { required: [...new Set(missing)] });
  }
}
