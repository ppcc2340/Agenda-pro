/**
 * Motor de automatizaciones (manual CRM cap. 8 + manual monday caps. 10-25).
 *
 * Frase: CUANDO <disparador> [Y SOLO SI <condiciones AND/OR anidadas>] ENTONCES <acciones…>
 * Mejoras sobre monday: OR y ramas nativas, condiciones sobre fórmulas y agregados (reflejos),
 * «actualizar registro relacionado», aprobación humana con ramas, ejecución atómica opcional,
 * orden determinista por prioridad, días hábiles, planificador de fechas al minuto (sin fecha
 * auxiliar), historial con retención configurable y simulación (dry run).
 *
 * Gobierno: cada automatización se ejecuta con la identidad de su propietario (por defecto, el
 * usuario de servicio «Automatizaciones»); se cuentan las acciones ejecutadas contra un presupuesto
 * mensual con avisos al 60/80/100 %; protección de bucles por profundidad de cadena y por frecuencia.
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Db, type Row } from "../db.js";
import { id, now, renderTemplate, addDays } from "../lib/util.js";
import { buildWhere, type FilterGroup } from "../lib/filters.js";
import { onEvent, emit, type CrmEvent } from "./events.js";
import { createTask, completeTask } from "./tasks.js";
import { notify } from "./notifications.js";
import { sendMail } from "./email.js";
import { createContact } from "./contacts.js";
import { createCompany } from "./companies.js";
import { moveStage, createDeal } from "./deals.js";
import { createTicket } from "./tickets.js";
import { createObligation } from "./clm.js";
import { pickAssignee } from "./assignment.js";
import { logActivity } from "./activities.js";
import { ctxAs, buildCtx } from "./system.js";
import { hashPassword, token } from "../lib/util.js";
import { fieldDefs, computeFields, statusLabels, cellText, norm, addBusinessDays, RELATIONS, COMPUTED_TYPES, type FieldDef } from "./columns.js";
import { loadRecord, applyPatch, archiveRecord, cellsToPatch, recordName, OBJECT_TABLE, OBJECT_PATH, OBJECT_LABEL } from "./recordOps.js";
import { isCustomObjectKey } from "../lib/objectKeys.js";
import { createCustomRecord, findDef } from "./customObjects.js";

export { loadRecord };

/* ================================================================== catálogo */
export const TRIGGER_TYPES = [
  "record_created", "record_updated", "field_changed", "any_field_changed", "person_assigned", "status_unchanged", "button_clicked", "note_created",
  "subitem_created", "subitem_completed", "all_subitems_done",
  "date_arrives", "date_passed", "every_period", "scheduled_daily",
  "stage_changed", "deal_won", "deal_lost", "deal_inactive", "deal_stale", "form_submitted", "task_overdue", "score_threshold", "ticket_created", "ticket_sla_risk",
  "email_opened", "quote_viewed", "quote_accepted", "webhook_in",
] as const;
export const ACTION_TYPES = [
  "notify", "send_email", "log_note", "call_webhook",
  "update_field", "set_date", "shift_date", "set_number", "copy_field", "clear_field", "add_tag", "remove_tag", "add_score",
  "change_owner", "assign", "change_stage", "add_to_list",
  "create_task", "create_subitems", "complete_subitems", "set_parent", "create_record", "create_deal", "update_related", "duplicate_record", "archive_record",
  "branch", "request_approval", "delay", "ai_categorize", "ai_summarize",
] as const;
export const OBJECTS = ["contact", "company", "deal", "task", "ticket", "quote", "contract"] as const;

export const TRIGGER_INFO: Record<string, { label: string; group: string; object: boolean; help: string }> = {
  record_created: { label: "Se crea un elemento", group: "Elemento", object: true, help: "En cualquier origen: pantalla, API, importación, formulario o automatización." },
  record_updated: { label: "Cambia cualquier columna", group: "Columna", object: true, help: "Úsalo con condiciones: es el disparador que más acciones consume." },
  field_changed: { label: "Una columna cambia (de X a Y)", group: "Columna", object: true, help: "Deja «de» vacío para «cambia a Y» y «a» vacío para «cambia a cualquier valor». Funciona también con fórmulas y reflejos." },
  any_field_changed: { label: "Cualquier columna cambia (excepto…)", group: "Columna", object: true, help: "Como monday «cuando cualquier columna cambia», con lista de exclusiones." },
  person_assigned: { label: "Se asigna una persona", group: "Columna", object: true, help: "Propietario, asignado, legal o una columna de persona; opcionalmente a un usuario concreto." },
  status_unchanged: { label: "Una columna no cambia en N días", group: "Columna", object: true, help: "Contador desde el último cambio de ESA columna (registro de auditoría)." },
  button_clicked: { label: "Se pulsa un botón", group: "Manual", object: true, help: "Columna de tipo botón." },
  note_created: { label: "Se registra una actualización", group: "Elemento", object: true, help: "Nota, llamada, email o reunión en la ficha. Condición útil: _activity.body contiene @soporte." },
  subitem_created: { label: "Se crea un subelemento", group: "Subelementos", object: true, help: "Tareas de un contacto, empresa, negocio o ticket; obligaciones de un contrato." },
  subitem_completed: { label: "Un subelemento se completa", group: "Subelementos", object: true, help: "Tarea completada u obligación cumplida/incumplida." },
  all_subitems_done: { label: "Todos los subelementos están hechos", group: "Subelementos", object: true, help: "Se dispara al completar el último pendiente." },
  date_arrives: { label: "Llega una fecha (± días/horas)", group: "Tiempo", object: true, help: "El planificador calcula la hora exacta al cambiar la fecha: sin evaluación una vez al día ni fechas auxiliares. Cambiar la fecha reprograma; una fecha pasada no dispara con efecto retroactivo." },
  date_passed: { label: "La fecha ha pasado y se cumplen las condiciones", group: "Tiempo", object: true, help: "Se reevalúa cada día mientras se cumpla: añade una acción que rompa la condición (p. ej. estado «Vencido»)." },
  every_period: { label: "Cada día / semana / mes", group: "Tiempo", object: true, help: "A una hora concreta; se inscriben los registros que cumplan las condiciones." },
  scheduled_daily: { label: "Cada día (heredado)", group: "Tiempo", object: true, help: "Equivale a «cada día» a primera hora." },
  stage_changed: { label: "Negocio cambia de etapa", group: "CRM", object: false, help: "" }, deal_won: { label: "Negocio ganado", group: "CRM", object: false, help: "" }, deal_lost: { label: "Negocio perdido", group: "CRM", object: false, help: "" },
  deal_inactive: { label: "Negocio sin actividad N días", group: "CRM", object: false, help: "" }, deal_stale: { label: "Negocio estancado en etapa", group: "CRM", object: false, help: "" },
  form_submitted: { label: "Formulario web enviado", group: "Integración", object: false, help: "" }, task_overdue: { label: "Tarea vencida", group: "CRM", object: false, help: "" },
  score_threshold: { label: "Puntuación supera umbral", group: "CRM", object: false, help: "" }, ticket_created: { label: "Ticket creado", group: "Soporte", object: false, help: "" }, ticket_sla_risk: { label: "Ticket a punto de incumplir SLA", group: "Soporte", object: false, help: "" },
  email_opened: { label: "Email abierto", group: "Integración", object: false, help: "" }, quote_viewed: { label: "Presupuesto visto", group: "CRM", object: false, help: "" }, quote_accepted: { label: "Presupuesto aceptado", group: "CRM", object: false, help: "" },
  webhook_in: { label: "Webhook externo recibido", group: "Integración", object: false, help: "POST /hooks/<id> con {object, record_id}" },
};
export const ACTION_INFO: Record<string, { label: string; group: string }> = {
  notify: { label: "Notificar", group: "Comunicar" }, send_email: { label: "Enviar email (HTML)", group: "Comunicar" }, log_note: { label: "Publicar actualización", group: "Comunicar" }, call_webhook: { label: "Enviar webhook", group: "Comunicar" },
  update_field: { label: "Establecer columna", group: "Datos" }, set_date: { label: "Establecer fecha", group: "Datos" }, shift_date: { label: "Empujar fecha N días", group: "Datos" }, set_number: { label: "Número: fijar / sumar / restar / copiar", group: "Datos" }, copy_field: { label: "Copiar columna", group: "Datos" }, clear_field: { label: "Limpiar columna", group: "Datos" }, add_tag: { label: "Añadir etiqueta", group: "Datos" }, remove_tag: { label: "Quitar etiqueta", group: "Datos" }, add_score: { label: "Sumar puntuación", group: "Datos" },
  assign: { label: "Asignar persona", group: "Personas" }, change_owner: { label: "Cambiar propietario (heredado)", group: "Personas" }, change_stage: { label: "Mover a etapa", group: "Organizar" }, add_to_list: { label: "Añadir a lista", group: "Organizar" },
  create_task: { label: "Crear tarea", group: "Crear" }, create_subitems: { label: "Crear subelementos (checklist)", group: "Crear" }, complete_subitems: { label: "Completar subelementos", group: "Subelementos" }, set_parent: { label: "Cambiar el elemento padre", group: "Subelementos" },
  create_record: { label: "Crear elemento en otro tablero (mapeo)", group: "Crear" }, create_deal: { label: "Crear negocio", group: "Crear" }, update_related: { label: "Actualizar elemento conectado", group: "Tableros cruzados" }, duplicate_record: { label: "Duplicar elemento", group: "Organizar" }, archive_record: { label: "Archivar (papelera)", group: "Organizar" },
  branch: { label: "Si… entonces / si no (rama)", group: "Flujo" }, request_approval: { label: "Pedir aprobación (ramas sí / no)", group: "Flujo" }, delay: { label: "Esperar", group: "Flujo" },
  ai_categorize: { label: "Clasificar texto (IA local por reglas)", group: "IA" }, ai_summarize: { label: "Resumir texto (IA local extractiva)", group: "IA" },
};

/* ================================================================== esquemas */
export const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  object: z.string().refine((o) => (OBJECTS as readonly string[]).includes(o) || isCustomObjectKey(o), "Objeto no válido").optional(),
  field: z.string().optional(), value: z.string().optional(), from: z.string().optional(), exclude: z.array(z.string()).optional(),
  stage_id: z.string().optional(), pipeline_id: z.string().optional(), form_id: z.string().optional(),
  days: z.number().int().min(0).optional(), min: z.number().optional(), hours: z.number().optional(),
  offset_days: z.number().int().min(-3650).max(3650).optional(), offset_hours: z.number().int().min(-720).max(720).optional(), at_hour: z.number().int().min(0).max(23).optional(), business_days: z.boolean().optional(),
  period: z.enum(["day", "week", "month"]).optional(), weekday: z.number().int().min(0).max(6).optional(), monthday: z.number().int().min(1).max(28).optional(),
  button: z.string().optional(), user_id: z.string().optional(),
});
type CondNode = { field?: string; op?: string; value?: unknown; logic?: "and" | "or"; conditions?: CondNode[] };
const condNode: z.ZodType<CondNode> = z.lazy(() => z.object({ field: z.string().optional(), op: z.string().optional(), value: z.any().optional(), logic: z.enum(["and", "or"]).optional(), conditions: z.array(condNode).optional() }));
export const conditionsSchema = z.object({ logic: z.enum(["and", "or"]).default("and"), conditions: z.array(condNode).default([]) });
export type Action = { type: (typeof ACTION_TYPES)[number]; [k: string]: unknown; then?: Action[]; else?: Action[] };
export const actionSchema: z.ZodType<Action> = z.lazy(() => z.object({ type: z.enum(ACTION_TYPES), then: z.array(actionSchema).optional(), else: z.array(actionSchema).optional() }).passthrough()) as z.ZodType<Action>;
export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  trigger: triggerSchema,
  conditions: conditionsSchema.default({ logic: "and", conditions: [] }),
  actions: z.array(actionSchema).default([]),
  active: z.boolean().optional(),
  allow_reenroll: z.boolean().optional(),
  owner_id: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  atomic: z.boolean().optional(),
  review_at: z.string().nullable().optional(),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;
type Trigger = z.infer<typeof triggerSchema>;

/* ================================================================== usuario de servicio */
export function ensureServiceUser(db: Db, ws: string): string {
  const ex = db.get<{ id: string }>("SELECT id FROM users WHERE workspace_id=? AND is_service=1 LIMIT 1", ws);
  if (ex) return ex.id;
  const role = db.get<{ id: string }>("SELECT id FROM roles WHERE workspace_id=? AND key='admin'", ws);
  if (!role) return "";
  const uid = id();
  db.insert("users", { id: uid, workspace_id: ws, name: "Automatizaciones", email: `automatizaciones+${ws.slice(0, 8)}@servicio.local`, password_hash: hashPassword(token(24)), role_id: role.id, is_service: 1, created_at: now() });
  return uid;
}
export function serviceUserId(ctx: Ctx): string { return ensureServiceUser(ctx.db, ctx.ws); }

/* ================================================================== condiciones (anidadas, sobre valores calculados) */
function getPath(rec: Record<string, unknown>, path: string): unknown { return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), rec); }
export function evalCond(rec: Record<string, unknown>, c: CondNode): boolean {
  if (c.conditions) { const r = c.conditions.map((x) => evalCond(rec, x)); return !r.length || (c.logic === "or" ? r.some(Boolean) : r.every(Boolean)); }
  if (!c.field || !c.op) return true;
  let raw = getPath(rec, c.field);
  const textAlt = getPath(rec, `_text.${c.field}`);
  const v = c.value;
  const eqv = (a: unknown, b: unknown) => { if (Array.isArray(a)) return a.some((x) => norm(x) === norm(b)); if (typeof a === "boolean") return a === (b === true || norm(b) === "true" || norm(b) === "si" || norm(b) === "1"); const na = Number(a), nb = Number(b); if (a !== "" && a !== null && b !== "" && b !== null && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb; return norm(a) === norm(b); };
  const isEq = (b: unknown) => eqv(raw, b) || (textAlt !== undefined && eqv(textAlt, b));
  const s = raw === null || raw === undefined ? "" : Array.isArray(raw) ? raw.join(",") : String(raw);
  const n = Number(raw), nv = Number(v);
  const list = () => (Array.isArray(v) ? v : String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  switch (c.op) {
    case "eq": return isEq(v);
    case "neq": return !isEq(v);
    case "contains": return Array.isArray(raw) ? raw.some((x) => norm(x) === norm(v)) : norm(s).includes(norm(v)) || norm(textAlt).includes(norm(v));
    case "not_contains": return Array.isArray(raw) ? !raw.some((x) => norm(x) === norm(v)) : !norm(s).includes(norm(v));
    case "starts": return norm(s).startsWith(norm(v));
    case "gt": return !Number.isNaN(n) && s !== "" ? n > nv : s > String(v);
    case "gte": return !Number.isNaN(n) && s !== "" ? n >= nv : s >= String(v);
    case "lt": return !Number.isNaN(n) && s !== "" ? n < nv : s < String(v);
    case "lte": return !Number.isNaN(n) && s !== "" ? n <= nv : s <= String(v);
    case "empty": return raw === null || raw === undefined || s === "" || (Array.isArray(raw) && raw.length === 0);
    case "not_empty": return !(raw === null || raw === undefined || s === "" || (Array.isArray(raw) && raw.length === 0));
    case "in": return list().some((x) => isEq(x));
    case "not_in": return !list().some((x) => isEq(x));
    case "last_days": return !!s && Date.now() - new Date(s).getTime() <= (Number(v) || 0) * 86400000 && new Date(s).getTime() <= Date.now();
    case "next_days": { const t = new Date(s).getTime(); return !!s && t >= Date.now() - 86400000 && t <= Date.now() + (Number(v) || 0) * 86400000; }
    case "before": return !!s && s.slice(0, 10) < (v === "today" ? now().slice(0, 10) : String(v));
    case "after": return !!s && s.slice(0, 10) > (v === "today" ? now().slice(0, 10) : String(v));
    case "today": return s.slice(0, 10) === now().slice(0, 10);
    case "past": return !!s && s.slice(0, 10) < now().slice(0, 10);
    case "future": return !!s && s.slice(0, 10) > now().slice(0, 10);
    case "is_true": return raw === 1 || raw === true || raw === "true";
    case "is_false": return !(raw === 1 || raw === true || raw === "true");
    case "changed": return getPath(rec, `_changes.${c.field}`) !== undefined;
    default: raw = undefined; return false;
  }
}
export function matchesGroup(rec: Record<string, unknown>, g: CondNode | FilterGroup | undefined): boolean { return evalCond(rec, (g ?? {}) as CondNode); }

/** Prepara el registro para condiciones/plantillas: valores calculados, textos de estado, origen, actor y cambios. */
function prepare(ctx: Ctx, object: string, record: Record<string, unknown>, ev?: CrmEvent): Record<string, unknown> {
  const rec: Row = { ...record };
  const defs = OBJECT_TABLE[object] ? fieldDefs(ctx, object) : [];
  if (defs.length) {
    const { values } = computeFields(ctx, object, rec, defs);
    rec.custom = { ...((rec.custom as Row) ?? {}), ...values };
    const text: Row = {};
    for (const d of defs) text[`custom.${d.key}`] = cellText(ctx, d.type, (rec.custom as Row)[d.key], d);
    rec._text = { custom: Object.fromEntries(defs.map((d) => [d.key, text[`custom.${d.key}`]])) };
  }
  rec._origin = ev?.meta?.origin ?? null;
  rec._actor = ev?.meta?.actor ?? null;
  rec._changes = Object.fromEntries(Object.entries(ev?.changes ?? {}).map(([k, v]) => [k.replace(/^custom\./, "custom_"), v]));
  for (const k of Object.keys(ev?.changes ?? {})) if (k.startsWith("custom.")) { (rec._changes as Row).custom = (rec._changes as Row).custom ?? {}; ((rec._changes as Row).custom as Row)[k.slice(7)] = ev!.changes![k]; }
  rec._prev = ev?.previous ?? null;
  rec._activity = ev?.meta?.activity ?? null;
  rec._subitem = ev?.meta?.subitem ?? null;
  return rec;
}

/* ================================================================== emparejamiento de disparadores */
const EVENT_TO_TRIGGER: Record<string, string[]> = {
  created: ["record_created"], updated: ["record_updated", "field_changed", "score_threshold", "any_field_changed", "person_assigned"], stage_changed: ["stage_changed", "field_changed", "any_field_changed"], won: ["deal_won", "field_changed"], lost: ["deal_lost", "field_changed"],
  status_changed: ["field_changed", "any_field_changed"], resolved: ["field_changed", "record_updated", "any_field_changed"],
  submitted: ["form_submitted"], overdue: ["task_overdue"], inactive: ["deal_inactive"], stale: ["deal_stale"], sla_risk: ["ticket_sla_risk"], opened: ["email_opened"], viewed: ["quote_viewed"], accepted: ["quote_accepted"], webhook_in: ["webhook_in"], button: ["button_clicked"],
};
const NO_OBJECT_CHECK = new Set(["form_submitted", "email_opened", "quote_viewed", "quote_accepted", "deal_won", "deal_lost", "stage_changed", "deal_inactive", "deal_stale", "task_overdue", "ticket_sla_risk", "webhook_in"]);
/** ¿El valor (crudo o texto de etiqueta) coincide con lo esperado? */
function valueIs(ctx: Ctx, object: string, field: string, raw: unknown, expected: string): boolean {
  if (norm(raw) === norm(expected)) return true;
  if (field === "status" && isCustomObjectKey(object)) { const st = findDef(ctx, object)?.statuses.find((s) => String(s.id) === String(raw)); return !!st && norm(st.label) === norm(expected); }
  if (field.startsWith("custom.")) { const d = fieldDefs(ctx, object).find((x) => x.key === field.slice(7)); if (d?.type === "status") return norm(cellText(ctx, "status", raw, d)) === norm(expected); if (d?.type === "user") return norm(cellText(ctx, "user", raw)) === norm(expected); }
  if (/_id$/.test(field) && raw) { const u = ctx.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", raw); if (u && norm(u.name) === norm(expected)) return true; const s = ctx.db.get<{ name: string }>("SELECT name FROM stages WHERE id=?", raw); if (s && norm(s.name) === norm(expected)) return true; }
  return false;
}
function triggerMatches(ctx: Ctx, t: Trigger, ev: CrmEvent): boolean {
  const kind = ev.type.split(".").slice(1).join(".");
  const candidates = EVENT_TO_TRIGGER[kind] ?? [];
  if (!candidates.includes(t.type)) return false;
  if (t.type === "ticket_created") return ev.type === "ticket.created";
  if (t.object && t.object !== ev.object && !NO_OBJECT_CHECK.has(t.type)) return false;
  switch (t.type) {
    case "record_created": return ev.type === `${t.object ?? ev.object}.created`;
    case "record_updated": return !!Object.keys(ev.changes ?? {}).length || ev.type.endsWith(".updated");
    case "any_field_changed": { const keys = Object.keys(ev.changes ?? {}).filter((k) => k !== "custom" && !(t.exclude ?? []).includes(k)); return keys.length > 0; }
    case "field_changed": {
      if (!t.field) return false;
      const ch = ev.changes?.[t.field];
      if (!ch) return false;
      if (t.from !== undefined && t.from !== "" && !valueIs(ctx, ev.object, t.field, ch[0], t.from)) return false;
      if (t.value !== undefined && t.value !== "" && !valueIs(ctx, ev.object, t.field, ch[1], t.value)) return false;
      return true;
    }
    case "person_assigned": {
      const fields = t.field ? [t.field] : ["owner_id", "assignee_id", "legal_owner_id"];
      for (const f of fields) { const ch = ev.changes?.[f]; if (ch && ch[1]) return !t.user_id || String(ch[1]) === t.user_id || (t.user_id === "@actor" && String(ch[1]) === String(ev.meta?.actor)); }
      return false;
    }
    case "stage_changed":
      if (!ev.type.endsWith("stage_changed")) return false;
      if (t.pipeline_id && ev.record.pipeline_id !== t.pipeline_id) return false;
      if (t.stage_id && ev.record.stage_id !== t.stage_id) return false;
      return true;
    case "deal_won": return ev.type === "deal.won";
    case "deal_lost": return ev.type === "deal.lost";
    case "form_submitted": return !t.form_id || ev.meta?.form_id === t.form_id;
    case "button_clicked": return !t.button || ev.meta?.button === t.button;
    case "score_threshold": { const ch = ev.changes?.score; if (!ch) return false; const min = t.min ?? 50; return Number(ch[0] ?? 0) < min && Number(ch[1] ?? 0) >= min; }
    case "deal_inactive": return (ev.meta?.days as number | undefined) === undefined || (t.days ?? 7) <= (ev.meta?.days as number);
    default: return true;
  }
}

/* ================================================================== ejecución */
export function registerWorkflowEngine() {
  onEvent((ctx, ev) => { if (ev.meta?.planner_skip) return; runForEvent(ctx, ev); try { planForEvent(ctx, ev); } catch (e) { console.error("[planner]", e); } });
}
function activeWorkflows(ctx: Ctx): Row[] {
  return ctx.db.all<Row>("SELECT * FROM workflows WHERE workspace_id=? AND active=1 ORDER BY priority, created_at", ctx.ws).map((w) => parseJson(w, ["trigger", "conditions", "actions"]) as Row);
}
/** Añade a `changes` los cambios de columnas calculadas (fórmulas, reflejos) para que puedan disparar. */
function withComputedChanges(ctx: Ctx, ev: CrmEvent, wfs: Row[]): CrmEvent {
  if (!ev.previous || !OBJECT_TABLE[ev.object]) return ev;
  const keys = wfs.map((w) => (w.trigger as Trigger)).filter((t) => (t.type === "field_changed" || t.type === "any_field_changed") && (!t.object || t.object === ev.object)).map((t) => t.field ?? "*");
  if (!keys.length) return ev;
  const defs = fieldDefs(ctx, ev.object).filter((d) => COMPUTED_TYPES.includes(d.type) && (keys.includes("*") || keys.includes(`custom.${d.key}`)));
  if (!defs.length) return ev;
  const prevVals = computeFields(ctx, ev.object, ev.previous as Row, fieldDefs(ctx, ev.object)).values;
  const curVals = computeFields(ctx, ev.object, ev.record as Row, fieldDefs(ctx, ev.object)).values;
  const changes = { ...(ev.changes ?? {}) };
  for (const d of defs) if (JSON.stringify(prevVals[d.key] ?? null) !== JSON.stringify(curVals[d.key] ?? null)) changes[`custom.${d.key}`] = [prevVals[d.key] ?? null, curVals[d.key] ?? null];
  return { ...ev, changes };
}
export function runForEvent(ctx: Ctx, ev: CrmEvent) {
  const wfs = activeWorkflows(ctx);
  if (!wfs.length) return;
  // subelementos y actualizaciones: se ejecutan sobre el elemento padre
  if (ev.type === "task.created" || ev.type === "task.completed") return runSubitemTriggers(ctx, wfs, ev);
  if (ev.type === "obligation.fulfilled" || ev.type === "obligation.breached") return runObligationTriggers(ctx, wfs, ev);
  if (ev.type === "activity.created") {
    for (const w of wfs) { const t = w.trigger as Trigger; if (t.type !== "note_created" || (t.object && t.object !== ev.object)) continue; const rec = loadRecord(ctx, ev.object, String(ev.record.id)); if (rec) runWorkflow(ctx, w, rec, { ...ev, record: rec }, { force: true }); }
    return;
  }
  const e2 = withComputedChanges(ctx, ev, wfs);
  for (const w of wfs) if (triggerMatches(ctx, w.trigger as Trigger, e2)) runWorkflow(ctx, w, e2.record, e2);
}
function taskParent(t: Row): { object: string; id: string } | null {
  return t.deal_id ? { object: "deal", id: String(t.deal_id) } : t.ticket_id ? { object: "ticket", id: String(t.ticket_id) } : t.contact_id ? { object: "contact", id: String(t.contact_id) } : t.company_id ? { object: "company", id: String(t.company_id) } : null;
}
function runSubitemTriggers(ctx: Ctx, wfs: Row[], ev: CrmEvent) {
  const t = ev.record as Row; const p = taskParent(t); if (!p) return;
  const open = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks WHERE ${p.object}_id=? AND completed_at IS NULL`, p.id)?.n ?? 0;
  for (const w of wfs) {
    const tr = w.trigger as Trigger; if (tr.object && tr.object !== p.object) continue;
    const fire = (tr.type === "subitem_created" && ev.type === "task.created") || (tr.type === "subitem_completed" && ev.type === "task.completed") || (tr.type === "all_subitems_done" && ev.type === "task.completed" && open === 0);
    if (!fire) continue;
    const rec = loadRecord(ctx, p.object, p.id); if (rec) runWorkflow(ctx, w, rec, { ...ev, object: p.object as never, record: rec, meta: { ...(ev.meta ?? {}), subitem: t } }, { force: true });
  }
}
function runObligationTriggers(ctx: Ctx, wfs: Row[], ev: CrmEvent) {
  const cid = String(ev.record.id);
  const pending = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM obligations WHERE contract_id=? AND status IN ('pending','in_progress','breached')", cid)?.n ?? 0;
  const ob = ev.meta?.obligation_id ? ctx.db.get<Row>("SELECT * FROM obligations WHERE id=?", ev.meta.obligation_id) : null;
  for (const w of wfs) {
    const tr = w.trigger as Trigger; if (tr.object && tr.object !== "contract") continue;
    const fire = (tr.type === "subitem_completed") || (tr.type === "all_subitems_done" && ev.type === "obligation.fulfilled" && pending === 0);
    if (!fire) continue;
    const rec = loadRecord(ctx, "contract", cid); if (rec) runWorkflow(ctx, w, rec, { ...ev, record: rec, meta: { ...(ev.meta ?? {}), subitem: ob ?? null } }, { force: true });
  }
}

interface RunState { log: string[]; count: number; depth: number; ev?: CrmEvent; dry?: boolean }
function monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }
export function monthUsage(ctx: Ctx): number { return ctx.db.get<{ n: number }>("SELECT COALESCE(SUM(actions_count),0) n FROM workflow_runs WHERE workspace_id=? AND ran_at >= ?", ctx.ws, monthStart())?.n ?? 0; }
function admins(ctx: Ctx): string[] { return ctx.db.all<{ id: string }>("SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.workspace_id=? AND r.key='admin' AND u.active=1 AND u.is_service=0", ctx.ws).map((x) => x.id); }
function pauseWorkflow(ctx: Ctx, w: Row, reason: string) {
  ctx.db.update("workflows", String(w.id), { active: 0, paused_reason: reason, updated_at: now() });
  for (const a of admins(ctx)) notify(ctx.db, ctx.ws, a, { type: "workflow", title: `Automatización pausada: ${w.name}`, body: reason, link: "/ajustes/automatizaciones" });
}
function checkBudgetAlerts(ctx: Ctx) {
  const budget = ctx.settings.automation_budget ?? 25000; if (!budget) return;
  const used = monthUsage(ctx); const month = monthStart().slice(0, 7);
  for (const th of [60, 80, 100]) {
    if (used < (budget * th) / 100) continue;
    const key = `auto_alert:${month}:${th}`;
    if (ctx.db.get("SELECT 1 FROM counters WHERE workspace_id=? AND key=?", ctx.ws, key)) continue;
    ctx.db.run("INSERT OR IGNORE INTO counters (workspace_id, key, value) VALUES (?,?,1)", ctx.ws, key);
    for (const a of admins(ctx)) notify(ctx.db, ctx.ws, a, { type: "workflow", title: `Acciones de automatización al ${th} % del mes`, body: `${used} de ${budget} acciones usadas.${th >= 100 ? (ctx.settings.automation_budget_mode === "pause_all" ? " Las automatizaciones quedan en pausa hasta el mes que viene." : " Las existentes siguen funcionando; no se pueden crear ni editar hasta el mes que viene o hasta ampliar el presupuesto.") : ""}`, link: "/ajustes/automatizaciones?tab=uso" });
  }
}
export function budgetExceeded(ctx: Ctx): boolean { const b = ctx.settings.automation_budget ?? 25000; return b > 0 && monthUsage(ctx) >= b; }
function describeTrigger(t: Trigger): string { const i = TRIGGER_INFO[t.type]; return `${i?.label ?? t.type}${t.object ? ` (${OBJECT_LABEL[t.object] ?? t.object})` : ""}${t.field ? ` · ${t.field}` : ""}${t.from ? ` de «${t.from}»` : ""}${t.value ? ` a «${t.value}»` : ""}`; }

/** Contexto de ejecución: el propietario de la automatización, marcado como origen «automation». */
function executionCtx(ctx: Ctx, w: Row): Ctx | string {
  const owner = (w.owner_id as string | null) ?? serviceUserId(ctx);
  const u = ctx.db.get<Row>("SELECT * FROM users WHERE id=?", owner);
  if (!u || !u.active) return `El propietario de la automatización (${u?.name ?? "desconocido"}) está desactivado o ya no existe: reasígnalo en el centro de automatizaciones`;
  const c = u.id === ctx.user.id ? ctx : buildCtx(ctx.db, u, "session", "automation");
  return { ...c, origin: "automation", automation: { id: String(w.id), name: String(w.name) } };
}

export function runWorkflow(ctx: Ctx, w: Row, record: Record<string, unknown>, ev?: CrmEvent, opts: { force?: boolean } = {}) {
  const started = Date.now();
  const recordId = String(record.id ?? "");
  const t = w.trigger as Trigger;
  const object = (ev?.object ?? t.object ?? "contact") as string;
  const depth = (ev?.depth ?? 0) + 1;
  const base = { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object, record_id: recordId, trigger_desc: describeTrigger(t), origin: String(ev?.meta?.origin ?? ""), depth };
  const record_ = (status: string, log: string[], extra: Row = {}) => ctx.db.insert("workflow_runs", { ...base, status, log, ran_at: now(), duration_ms: Date.now() - started, ...extra });
  if (!opts.force && !w.allow_reenroll && ctx.db.get("SELECT id FROM workflow_runs WHERE workflow_id=? AND record_id=? AND status IN ('ok','waiting')", w.id, recordId)) return;
  if (ctx.settings.automation_budget_mode === "pause_all" && budgetExceeded(ctx)) { record_("skipped", ["Presupuesto mensual de acciones agotado: automatizaciones en pausa"]); return; }
  if (depth > (ctx.settings.automation_max_depth ?? 10)) { record_("error", [`Cadena de automatizaciones cortada en profundidad ${depth}: posible bucle`], { error: "Bucle cortado (profundidad)" }); pauseWorkflow(ctx, w, `Bucle detectado: la cadena de automatizaciones superó la profundidad ${ctx.settings.automation_max_depth ?? 10}. Añade una condición de corte o un estado terminal.`); return; }
  const recent = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id=? AND record_id=? AND ran_at > ? AND status != 'skipped'", w.id, recordId, new Date(Date.now() - 60000).toISOString())?.n ?? 0;
  if (recent >= 5) { record_("error", ["La automatización se ha ejecutado 5 veces en un minuto sobre el mismo elemento: se pausa por posible bucle"], { error: "Bucle detectado (frecuencia)" }); pauseWorkflow(ctx, w, "Bucle detectado: 5 ejecuciones en un minuto sobre el mismo elemento. Revisa las condiciones y añade un estado terminal."); return; }
  const ectx = executionCtx(ctx, w);
  if (typeof ectx === "string") { record_("error", [ectx], { error: ectx }); pauseWorkflow(ctx, w, ectx); return; }
  const rec = prepare(ectx, object, record, ev);
  if (!matchesGroup(rec, w.conditions as CondNode)) { record_("skipped", ["Las condiciones no se cumplen"]); return; }
  const state: RunState = { log: [], count: 0, depth, ev };
  let status: string;
  if (w.atomic) {
    try { status = ectx.db.transaction(() => { const s = executeActions(ectx, w, object, rec, (w.actions as Action[]) ?? [], state); if (s === "error") throw new Error("__rollback__"); return s; }); }
    catch (e) { status = "error"; state.log.push((e as Error).message === "__rollback__" ? "Ejecución atómica: se han deshecho todos los cambios de esta ejecución (los emails y webhooks ya enviados no se pueden deshacer)" : `Error: ${(e as Error).message}`); state.count = 0; }
  } else status = executeActions(ectx, w, object, rec, (w.actions as Action[]) ?? [], state);
  const err = status === "error" ? state.log.find((l) => l.startsWith("Error")) ?? "Error" : null;
  record_(status === "waiting" ? "waiting" : status, state.log, { actions_count: state.count, error: err });
  ctx.db.run("UPDATE workflows SET runs=runs+1, last_run_at=? WHERE id=?", now(), w.id);
  checkBudgetAlerts(ctx);
}

/** Ejecuta acciones en orden. Devuelve ok | error | waiting (espera o aprobación pendiente). */
export function executeActions(ctx: Ctx, w: Row, object: string, record: Record<string, unknown>, actions: Action[], st: RunState): "ok" | "error" | "waiting" {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    try {
      if (a.type === "delay") {
        const ms = ((Number(a.days ?? 0)) * 1440 + Number(a.hours ?? 0) * 60 + Number(a.minutes ?? 0)) * 60000;
        const rest = actions.slice(i + 1);
        if (st.dry) { st.log.push(`Esperar ${a.days ?? 0} d ${a.hours ?? 0} h ${a.minutes ?? 0} min`); continue; }
        if (rest.length) { ctx.db.insert("scheduled_jobs", { id: id(), workspace_id: ctx.ws, kind: "workflow_actions", payload: { workflow_id: w.id, object, record_id: record.id, actions: rest, depth: st.depth }, run_at: new Date(Date.now() + ms).toISOString() }); st.log.push(`Esperar ${a.days ?? 0} d ${a.hours ?? 0} h ${a.minutes ?? 0} min; ${rest.length} acción(es) programadas`); }
        return "ok";
      }
      if (a.type === "branch") {
        const fresh = st.dry ? record : prepare(ctx, object, loadRecord(ctx, object, String(record.id)) ?? record, st.ev);
        const yes = matchesGroup(fresh, (a.conditions ?? {}) as CondNode);
        st.log.push(`Rama: ${yes ? "se cumple → «entonces»" : "no se cumple → «si no»"}`);
        const r = executeActions(ctx, w, object, fresh, (yes ? a.then : a.else) ?? [], st);
        if (r !== "ok") return r;
        continue;
      }
      if (a.type === "request_approval") {
        const approver = resolveUsers(ctx, String(a.approver ?? "manager"), record, st)[0] ?? null;
        const t = tplCtx(ctx, object, record);
        if (st.dry) { st.log.push(`Pedir aprobación a ${approver ? userName(ctx, approver) : "—"}: «${renderTemplate(String(a.title ?? "Aprobar {{name}}"), t)}» (ramas sí/no)`); st.count++; continue; }
        const aid = id();
        ctx.db.insert("automation_approvals", { id: aid, workspace_id: ctx.ws, workflow_id: w.id, object, record_id: record.id, approver_id: approver, title: renderTemplate(String(a.title ?? "Aprobar {{name}}"), t), body: a.body ? renderTemplate(String(a.body), t) : null, status: "pending", payload: { then: a.then ?? [], else: a.else ?? [], rest: actions.slice(i + 1), depth: st.depth }, created_at: now() });
        notify(ctx.db, ctx.ws, approver, { type: "approval", title: `Aprobación pendiente: ${renderTemplate(String(a.title ?? "Aprobar {{name}}"), t)}`, body: `Automatización «${w.name}»`, link: "/ajustes/automatizaciones?tab=aprobaciones" });
        st.count++; st.log.push(`Aprobación solicitada a ${approver ? userName(ctx, approver) : "(sin aprobador)"}; el flujo continúa al decidir`);
        return "waiting";
      }
      if (st.dry) { st.log.push(describeAction(ctx, a, tplCtx(ctx, object, record))); st.count += actionCost(a); continue; }
      st.count += runAction(ctx, object, record, a, st);
    } catch (e) {
      st.log.push(`Error en «${ACTION_INFO[a.type]?.label ?? a.type}»: ${(e as Error).message}`);
      return "error";
    }
  }
  return "ok";
}
function actionCost(a: Action): number { if (a.type === "create_subitems") return String(a.titles ?? "").split("\n").filter((x) => x.trim()).length || 1; return 1; }
const userName = (ctx: Ctx, uid: string) => ctx.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", uid)?.name ?? uid;

/** Destinatarios: owner, manager, creator, actor (quien disparó), legal, user:<id>, team:<id>, team_manager, admins; separados por comas. */
function resolveUsers(ctx: Ctx, spec: string | undefined, record: Record<string, unknown>, st?: RunState): string[] {
  const out: string[] = [];
  for (const s of String(spec || "owner").split(",").map((x) => x.trim()).filter(Boolean)) {
    const owner = (record.owner_id as string | null) ?? (record.assignee_id as string | null) ?? null;
    if (s === "owner") { if (owner) out.push(owner); }
    else if (s === "creator") { if (record.created_by) out.push(String(record.created_by)); }
    else if (s === "actor") { const a = st?.ev?.meta?.actor ?? record._actor; if (a) out.push(String(a)); }
    else if (s === "legal") { if (record.legal_owner_id) out.push(String(record.legal_owner_id)); }
    else if (s === "manager" || s === "team_manager") { const m = ctx.db.get<{ manager_id: string | null }>("SELECT t.manager_id FROM users u JOIN teams t ON t.id=u.team_id WHERE u.id=?", owner ?? "")?.manager_id; if (m) out.push(m); }
    else if (s === "admins") out.push(...admins(ctx));
    else if (s.startsWith("user:")) out.push(s.slice(5));
    else if (s.startsWith("team:")) out.push(...ctx.db.all<{ id: string }>("SELECT id FROM users WHERE team_id=? AND active=1 AND is_service=0", s.slice(5)).map((u) => u.id));
    else if (s.startsWith("field:")) { const v = getPath(record, s.slice(6)); if (v) out.push(String(v)); }
  }
  return [...new Set(out)];
}
function tplCtx(ctx: Ctx, object: string, record: Record<string, unknown>) {
  const owner = ctx.db.get<Row>("SELECT name, email, email_signature FROM users WHERE id=?", (record.owner_id as string | null) ?? (record.assignee_id as string | null) ?? "");
  const name = recordName(object, record as Row);
  const text = ((record._text as Row | undefined)?.custom ?? {}) as Row;
  return { ...record, campo: text, nombre: record.first_name ?? name, apellidos: record.last_name ?? "", name, empresa: (record.company as Row | null)?.name ?? record.company_name ?? "", importe: record.amount ?? record.total_value ?? "", propietario: { nombre: owner?.name ?? "", email: owner?.email ?? "", firma: owner?.email_signature ?? "" }, owner: { name: owner?.name ?? "", signature: owner?.email_signature ?? "" }, company: record.company ?? {}, contact: record, deal: record, hoy: now().slice(0, 10), enlace: `${process.env.PUBLIC_URL ?? ""}${OBJECT_PATH[object] ?? ""}/${record.id}`, tablero: OBJECT_LABEL[object] ?? object, actividad: record._activity ?? {}, subelemento: record._subitem ?? {} };
}
function links(object: string, record: Record<string, unknown>) {
  return {
    contact_id: object === "contact" ? (record.id as string) : ((record.contact_id as string | null) ?? null),
    company_id: object === "company" ? (record.id as string) : ((record.company_id as string | null) ?? (record.counterparty_company_id as string | null) ?? null),
    deal_id: object === "deal" ? (record.id as string) : ((record.deal_id as string | null) ?? null),
    ticket_id: object === "ticket" ? (record.id as string) : null,
    ...(isCustomObjectKey(object) ? { record_object: object, record_id: record.id as string } : {}),
  };
}
const linkOf = (object: string, rid: string) => (OBJECT_PATH[object] ? `${OBJECT_PATH[object]}/${rid}` : undefined);
function fieldValue(record: Record<string, unknown>, f: string): unknown { return f.startsWith("custom.") ? (record.custom as Row | undefined)?.[f.slice(7)] : record[f]; }
function patchFor(field: string, value: unknown): Record<string, unknown> { return cellsToPatch({ [field]: value }); }
function isoDay(d: Date) { return d.toISOString().slice(0, 10); }
function offsetDate(base: Date, days: number, business: boolean): Date { return business ? addBusinessDays(base, days) : new Date(base.getTime() + days * 86400000); }
function coerceValue(v: string): unknown { if (v === "true") return true; if (v === "false") return false; if (v === "") return null; if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v); return v; }

/** Ejecuta una acción; devuelve cuántas acciones consume. */
function runAction(ctx: Ctx, object: string, record: Record<string, unknown>, a: Action, st: RunState): number {
  const t = tplCtx(ctx, object, record);
  const rid = String(record.id);
  const log = st.log; const depth = st.depth;
  const str = (k: string, d = "") => String(a[k] ?? d);
  switch (a.type) {
    case "create_task": {
      const assignee = resolveUsers(ctx, str("assignee", "owner"), record, st)[0] ?? null;
      const task = createTask(ctx, { title: renderTemplate(str("title", "Seguimiento"), t), type: (a.task_type as "call") ?? "followup", due_at: addDays(now(), Number(a.due_in_days ?? 1)), priority: (a.priority as "high") ?? "normal", assignee_id: assignee, description: a.body ? renderTemplate(str("body"), t) : null, ...links(object, record) });
      log.push(`Tarea creada: ${task.title}`); return 1;
    }
    case "create_subitems": {
      const titles = str("titles").split("\n").map((x) => x.trim()).filter(Boolean);
      if (!titles.length) throw new Error("Escribe al menos un subelemento");
      if (object === "contract") { for (const ti of titles) createObligation(ctx, rid, { title: renderTemplate(ti, t), due_date: isoDay(new Date(Date.now() + Number(a.due_in_days ?? 7) * 86400000)), owner_id: resolveUsers(ctx, str("assignee", "owner"), record, st)[0] ?? null } as never); log.push(`${titles.length} obligación(es) creadas`); return titles.length; }
      const assignee = resolveUsers(ctx, str("assignee", "owner"), record, st)[0] ?? null;
      for (const ti of titles) createTask(ctx, { title: renderTemplate(ti, t), type: "todo", due_at: addDays(now(), Number(a.due_in_days ?? 1)), priority: "normal", assignee_id: assignee, ...links(object, record) });
      log.push(`${titles.length} subelemento(s) creados`); return titles.length;
    }
    case "complete_subitems": {
      const col = object === "deal" ? "deal_id" : object === "contact" ? "contact_id" : object === "company" ? "company_id" : object === "ticket" ? "ticket_id" : null;
      if (!col) throw new Error("Este tablero no tiene tareas como subelementos");
      const open = ctx.db.all<{ id: string }>(`SELECT id FROM tasks WHERE ${col}=? AND completed_at IS NULL`, rid);
      for (const x of open) completeTask(ctx, x.id, "Completada por automatización");
      log.push(`${open.length} subelemento(s) completados`); return Math.max(1, open.length);
    }
    case "set_parent": {
      if (object !== "task") throw new Error("Solo aplica cuando el disparador es una tarea (subelemento)");
      const p = taskParent(record as Row); if (!p) throw new Error("La tarea no tiene elemento padre");
      applyPatch(ctx, p.object, p.id, patchFor(str("field"), coerceValue(renderTemplate(str("value"), t))), depth);
      log.push(`Padre (${OBJECT_LABEL[p.object]}): ${str("field")} = ${str("value")}`); return 1;
    }
    case "notify": {
      const title = renderTemplate(str("title", "Aviso del CRM"), t);
      const body = a.body ? renderTemplate(str("body"), t) : undefined;
      const to = a.to?.toString().startsWith("team:") || str("to").includes(",") ? resolveUsers(ctx, str("to"), record, st) : resolveUsers(ctx, str("to", "owner"), record, st);
      for (const u of to) notify(ctx.db, ctx.ws, u, { type: "workflow", title, body, link: linkOf(object, rid) });
      log.push(`Aviso a ${to.length ? to.map((u) => userName(ctx, u)).join(", ") : "(sin destinatario)"}: ${title}`); return 1;
    }
    case "send_email": {
      const tpl = a.template_id ? ctx.db.get<Row>("SELECT * FROM email_templates WHERE id=? AND workspace_id=?", a.template_id, ctx.ws) : null;
      const subject = renderTemplate((tpl?.subject as string | undefined) ?? str("title"), t);
      const body = renderTemplate((tpl?.body as string | undefined) ?? str("body"), t);
      let to: string | null = null, contactId: string | null = null;
      if (!a.to || a.to === "contact") {
        const c = object === "contact" ? record : record.contact_id ? ctx.db.get<Row>("SELECT * FROM contacts WHERE id=?", record.contact_id) : object === "deal" ? ctx.db.get<Row>("SELECT c.* FROM contacts c JOIN deal_contacts dc ON dc.contact_id=c.id WHERE dc.deal_id=? LIMIT 1", rid) : null;
        if (c?.do_not_contact) { log.push("Email omitido: el contacto no desea ser contactado"); return 0; }
        to = (c?.email as string | null) ?? null; contactId = (c?.id as string | null) ?? null;
      } else { const u = resolveUsers(ctx, str("to"), record, st)[0]; to = u ? (ctx.db.get<{ email: string }>("SELECT email FROM users WHERE id=?", u)?.email ?? null) : null; }
      if (!to) { log.push("Email omitido: sin dirección"); return 0; }
      const html = /<[a-z][\s\S]*>/i.test(body) ? body : body.replace(/\n/g, "<br/>");
      const act = contactId ? logActivity(ctx, { type: "email", subject, body, direction: "outbound", contact_id: contactId, deal_id: object === "deal" ? rid : null, meta: { automated: true } }) : null;
      void sendMail(ctx.db, ctx.ws, { to, subject, html, contactId, userId: ctx.user.id, activityId: (act?.id as string | undefined) ?? null }).catch((e) => console.error("[workflow email]", e));
      log.push(`Email enviado a ${to}: ${subject}`); return 1;
    }
    case "update_field": {
      if (!a.field) throw new Error("Falta la columna");
      const value = renderTemplate(str("value"), t);
      applyPatch(ctx, object, rid, patchFor(str("field"), str("field").startsWith("custom.") ? value : coerceValue(value)), depth);
      log.push(`${str("field")} = ${value}`); return 1;
    }
    case "set_date": {
      if (!a.field) throw new Error("Falta la columna de fecha");
      const mode = str("mode", "today"); const business = !!a.business_days; const days = Number(a.days ?? 0);
      let base: Date;
      if (mode === "fixed") base = new Date(`${str("value")}T00:00:00Z`);
      else if (mode === "field") { const src = fieldValue(record, str("source_field")); if (!src) throw new Error(`La columna origen ${str("source_field")} está vacía`); const s = typeof src === "object" ? String((src as Row).to ?? "") : String(src); base = new Date(s.length === 10 ? `${s}T00:00:00Z` : s); }
      else base = new Date(`${now().slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(base.getTime())) throw new Error("Fecha origen no válida");
      const value = isoDay(offsetDate(base, days, business));
      applyPatch(ctx, object, rid, patchFor(str("field"), value), depth);
      log.push(`${str("field")} = ${value}${days ? ` (${days >= 0 ? "+" : ""}${days} días${business ? " hábiles" : ""})` : ""}`); return 1;
    }
    case "shift_date": {
      const cur = fieldValue(record, str("field")); if (!cur) throw new Error("La fecha está vacía");
      const value = isoDay(offsetDate(new Date(`${String(cur).slice(0, 10)}T00:00:00Z`), Number(a.days ?? 1), !!a.business_days));
      applyPatch(ctx, object, rid, patchFor(str("field"), value), depth); log.push(`${str("field")} empujada a ${value}`); return 1;
    }
    case "set_number": {
      const mode = str("mode", "set"); const cur = Number(fieldValue(record, str("field")) ?? 0) || 0; const val = Number(renderTemplate(str("value", "0"), t));
      const src = Number(fieldValue(record, str("source_field")) ?? 0) || 0;
      const value = mode === "increment" ? cur + val : mode === "decrement" ? cur - val : mode === "copy" ? src : mode === "multiply" ? cur * val : val;
      applyPatch(ctx, object, rid, patchFor(str("field"), value), depth); log.push(`${str("field")} = ${value}`); return 1;
    }
    case "copy_field": { const v = fieldValue(record, str("source_field")); applyPatch(ctx, object, rid, patchFor(str("field"), v ?? null), depth); log.push(`${str("field")} ← ${str("source_field")}`); return 1; }
    case "clear_field": { applyPatch(ctx, object, rid, patchFor(str("field"), str("field") === "tags" ? [] : null), depth); log.push(`${str("field")} vaciada`); return 1; }
    case "assign":
    case "change_owner": {
      const mode = str("mode", a.user_id ? "fixed" : "round_robin");
      let uid: string | null = null;
      if (mode === "round_robin" || mode === "least_loaded") uid = pickAssignee(ctx.db, ctx.ws, { mode: mode as "round_robin", team_id: (a.team_id as string | undefined) ?? null }, `wf:${a.team_id ?? "all"}`);
      else if (mode === "creator") uid = (record.created_by as string | null) ?? null;
      else if (mode === "actor") uid = (st.ev?.meta?.actor as string | null) ?? null;
      else if (mode === "team_manager") uid = resolveUsers(ctx, "manager", record, st)[0] ?? null;
      else if (mode === "unassign") uid = null;
      else uid = (a.user_id as string | null) ?? null;
      if (!uid && mode !== "unassign") throw new Error("No hay usuario al que asignar");
      const field = str("field") || (object === "ticket" || object === "task" ? "assignee_id" : "owner_id");
      applyPatch(ctx, object, rid, patchFor(field, uid), depth);
      if (uid) notify(ctx.db, ctx.ws, uid, { type: "assigned", title: `Se te ha asignado: ${t.name}`, link: linkOf(object, rid) });
      log.push(mode === "unassign" ? `${field} sin asignar` : `${field} → ${userName(ctx, uid!)}`); return 1;
    }
    case "change_stage": { if (object !== "deal" || !a.stage_id) throw new Error("Solo aplica a negocios"); moveStage(ctx, rid, str("stage_id"), { depth, skipValidation: true }); log.push("Etapa cambiada"); return 1; }
    case "add_tag": case "remove_tag": {
      const tags = Array.isArray(record.tags) ? [...(record.tags as string[])] : [];
      const tag = renderTemplate(str("tag"), t);
      const next = a.type === "add_tag" ? (tags.includes(tag) ? tags : [...tags, tag]) : tags.filter((x) => x !== tag);
      if (JSON.stringify(next) !== JSON.stringify(tags)) applyPatch(ctx, object, rid, { tags: next }, depth);
      log.push(`${a.type === "add_tag" ? "Etiqueta añadida" : "Etiqueta quitada"}: ${tag}`); return 1;
    }
    case "add_to_list": { if (!a.list_id) throw new Error("Falta la lista"); ctx.db.run("INSERT OR IGNORE INTO list_members (list_id, record_id, added_at) VALUES (?,?,?)", a.list_id, rid, now()); log.push("Añadido a la lista"); return 1; }
    case "add_score": { if (object !== "contact") throw new Error("Solo aplica a contactos"); ctx.db.run("UPDATE contacts SET score=MIN(100, MAX(0, score + ?)) WHERE id=?", Number(a.points ?? 0), rid); log.push(`Puntuación ${Number(a.points ?? 0) >= 0 ? "+" : ""}${a.points ?? 0}`); return 1; }
    case "call_webhook": {
      if (!a.url) throw new Error("Falta la URL");
      const payload = JSON.stringify({ event: "automation", automation: ctx.automation, object, record_id: rid, record: Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith("_"))), at: now() });
      void fetch(str("url"), { method: "POST", headers: { "content-type": "application/json", "x-crm-automation": String(ctx.automation?.id ?? "") }, body: payload }).catch((e) => console.error("[workflow webhook]", e));
      log.push(`Webhook enviado: ${str("url")}`); return 1;
    }
    case "create_deal": {
      const contactId = object === "contact" ? rid : (record.contact_id as string | null);
      const companyId = object === "company" ? rid : (record.company_id as string | null);
      const d = createDeal(ctx, { name: renderTemplate(str("name", "Negocio {{name}}"), t), pipeline_id: a.pipeline_id as string | undefined, company_id: companyId ?? null, owner_id: (record.owner_id as string | null) ?? ctx.user.id, contacts: contactId ? [{ contact_id: contactId, role: "decision_maker" }] : [] }, { depth });
      log.push(`Negocio creado: ${d.name}`); return 1;
    }
    case "create_record": {
      const target = str("object", "task");
      const map = (a.values ?? {}) as Record<string, string>;
      const vals: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(map)) vals[k] = String(v).startsWith("=") ? fieldValue(record, String(v).slice(1)) : renderTemplate(String(v), t);
      const input = cellsToPatch(vals) as Record<string, unknown>;
      const lk: { contact_id?: string | null; company_id?: string | null; deal_id?: string | null; ticket_id?: string | null; record_object?: string; record_id?: string } = a.connect === false ? {} : links(object, record);
      let created: Row;
      if (target === "deal") created = createDeal(ctx, { name: String(input.name ?? `Negocio ${t.name}`), company_id: (input.company_id as string | null) ?? lk.company_id ?? null, owner_id: (input.owner_id as string | null) ?? (record.owner_id as string | null) ?? ctx.user.id, amount: input.amount === undefined ? undefined : Number(input.amount), contacts: lk.contact_id ? [{ contact_id: lk.contact_id, role: "decision_maker" }] : [], custom: input.custom as Row | undefined } as never, { depth });
      else if (target === "ticket") created = createTicket(ctx, { subject: String(input.subject ?? `Seguimiento de ${t.name}`), description: (input.description as string | undefined) ?? null, priority: (input.priority as "normal") ?? "normal", contact_id: lk.contact_id, company_id: lk.company_id, assignee_id: (input.assignee_id as string | undefined) ?? null, custom: input.custom } as never, { depth });
      else if (isCustomObjectKey(target)) {
        // objeto personalizado: se vincula al elemento de origen (y a su empresa/contacto/negocio) por las relaciones que tenga
        const def = findDef(ctx, target); if (!def) throw new Error(`No existe el objeto ${target}`);
        const lks: Record<string, string[]> = {};
        if (a.connect !== false) for (const rel of def.relations) {
          const tid = rel.target === object ? String(record.id) : rel.target === "company" ? lk.company_id : rel.target === "contact" ? lk.contact_id : rel.target === "deal" ? lk.deal_id : rel.target === "ticket" ? lk.ticket_id : null;
          if (tid) lks[rel.key] = [tid];
        }
        created = createCustomRecord(ctx, target, { name: String(input.name ?? t.name), status: (input.status as string | undefined) ?? undefined, owner_id: (input.owner_id as string | undefined) ?? (record.owner_id as string | null) ?? ctx.user.id, custom: input.custom as Record<string, unknown> | undefined, links: lks }, { depth });
      }
      else if (target === "company") created = createCompany(ctx, { name: String(input.name ?? t.name), ...input } as never);
      else if (target === "contact") created = createContact(ctx, { first_name: String(input.first_name ?? t.name), ...input, company_id: (input.company_id as string | undefined) ?? lk.company_id ?? null } as never, { force: true, depth });
      else created = createTask(ctx, { title: String(input.title ?? `Seguimiento de ${t.name}`), type: "todo", due_at: addDays(now(), Number(a.due_in_days ?? 1)), priority: "normal", assignee_id: (input.assignee_id as string | undefined) ?? resolveUsers(ctx, "owner", record, st)[0] ?? null, ...lk });
      log.push(`Creado en ${isCustomObjectKey(target) ? findDef(ctx, target)?.plural ?? target : OBJECT_LABEL[target] ?? target}: ${recordName(target, created)}${a.connect === false ? "" : " (conectado)"}`); return 1;
    }
    case "update_related": {
      const rel = RELATIONS[object]?.[str("relation")]; if (!rel) throw new Error(`Relación no válida: ${str("relation")}`);
      const rows = rel.rows(ctx, record as Row).filter((r) => !a.only_if_field || evalCond({ ...r, custom: r.custom } as Row, { field: str("only_if_field"), op: str("only_if_op", "eq"), value: a.only_if_value }));
      const value = coerceValue(renderTemplate(str("value"), t));
      let n = 0;
      for (const r of rows) {
        if (rel.target === "obligation") { ctx.db.run(`UPDATE obligations SET ${str("field").replace(/[^a-z_]/g, "")}=?, updated_at=? WHERE id=?`, value, now(), r.id); n++; continue; }
        if (!["contact", "company", "deal", "ticket", "task", "contract"].includes(rel.target)) continue;
        applyPatch(ctx, rel.target, String(r.id), patchFor(str("field"), str("field").startsWith("custom.") ? renderTemplate(str("value"), t) : value), depth); n++;
      }
      log.push(`${n} elemento(s) conectado(s) (${rel.label}) actualizados: ${str("field")} = ${str("value")}`); return Math.max(1, n);
    }
    case "duplicate_record": {
      if (object === "deal") { const d = createDeal(ctx, { name: `${t.name} (copia)`, company_id: (record.company_id as string | null) ?? null, owner_id: (record.owner_id as string | null) ?? ctx.user.id, pipeline_id: record.pipeline_id as string, custom: record.custom as Row, tags: record.tags as string[], contacts: ((record.contacts as Row[]) ?? []).map((c) => ({ contact_id: String(c.id), role: String(c.role ?? "decision_maker") })) } as never, { depth }); log.push(`Duplicado: ${d.name}`); return 1; }
      if (object === "company") { const c = createCompany(ctx, { name: `${t.name} (copia)`, sector: record.sector, city: record.city, country: record.country, type: record.type, custom: record.custom, tags: record.tags } as never, { force: true }); log.push(`Duplicada: ${c.name}`); return 1; }
      if (object === "ticket") { const k = createTicket(ctx, { subject: `${t.name} (copia)`, description: record.description, priority: record.priority, contact_id: record.contact_id, company_id: record.company_id } as never, { depth }); log.push(`Duplicado: ${k.subject}`); return 1; }
      throw new Error("Duplicar está disponible para negocios, empresas y tickets");
    }
    case "archive_record": { archiveRecord(ctx, object, rid); log.push("Elemento enviado a la papelera"); return 1; }
    case "log_note": { logActivity(ctx, { type: "note", subject: renderTemplate(str("title", "Nota automática"), t), body: a.body ? renderTemplate(str("body"), t) : null, ...links(object, record), meta: { automated: true, automation: ctx.automation } }); log.push("Actualización publicada"); return 1; }
    case "ai_categorize": {
      const src = (Array.isArray(a.source_fields) ? (a.source_fields as string[]) : [str("source_field", "description")]).map((f) => String(fieldValue(record, f) ?? "")).join(" \n ");
      const rules = (a.rules ?? []) as { label: string; keywords: string }[];
      let best: { label: string; score: number } = { label: str("default_label"), score: 0 };
      for (const r of rules) { const score = String(r.keywords ?? "").split(",").map((k) => norm(k)).filter(Boolean).reduce((s, k) => s + (norm(src).split(k).length - 1), 0); if (score > best.score) best = { label: r.label, score }; }
      if (!best.label) { log.push("Clasificación: ninguna regla coincide"); return 1; }
      applyPatch(ctx, object, rid, patchFor(str("target_field"), best.label), depth);
      log.push(`Clasificado como «${best.label}» (${best.score} coincidencia(s); IA local por reglas, sin enviar datos fuera)`); return 1;
    }
    case "ai_summarize": {
      const txt = String(fieldValue(record, str("source_field", "description")) ?? "").replace(/\s+/g, " ").trim();
      if (!txt) { log.push("Resumen omitido: texto vacío"); return 1; }
      const sentences = txt.match(/[^.!?]+[.!?]*/g) ?? [txt];
      const words = norm(txt).split(/\W+/).filter((w) => w.length > 4); const freq: Record<string, number> = {}; for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
      const scored = sentences.map((s, i) => ({ s: s.trim(), i, score: norm(s).split(/\W+/).reduce((acc, w) => acc + (freq[w] ?? 0), 0) / Math.max(4, s.split(" ").length) }));
      const n = Number(a.sentences ?? 2);
      const summary = scored.sort((x, y) => y.score - x.score).slice(0, n).sort((x, y) => x.i - y.i).map((x) => x.s).join(" ").slice(0, 500);
      applyPatch(ctx, object, rid, patchFor(str("target_field"), summary), depth);
      log.push("Resumen generado (extractivo local)"); return 1;
    }
    default: throw new Error(`Acción desconocida: ${a.type}`);
  }
}

/** Continuar una automatización en espera (scheduler). */
export function resumeActions(ctx: Ctx, payload: { workflow_id: string; object: string; record_id: string; actions: Action[]; depth: number }) {
  const w = parseJson(ctx.db.get<Row>("SELECT * FROM workflows WHERE id=?", payload.workflow_id), ["trigger", "conditions", "actions"]);
  if (!w || !w.active) return;
  const ectx = executionCtx(ctx, w); if (typeof ectx === "string") return;
  const record = loadRecord(ectx, payload.object, payload.record_id); if (!record) return;
  const st: RunState = { log: ["Continuación tras la espera"], count: 0, depth: payload.depth };
  const status = executeActions(ectx, w, payload.object, prepare(ectx, payload.object, record), payload.actions, st);
  ctx.db.insert("workflow_runs", { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object: payload.object, record_id: payload.record_id, status, log: st.log, ran_at: now(), actions_count: st.count, trigger_desc: "Continuación tras espera", origin: "automation", depth: payload.depth });
}

/** Decide una aprobación pedida por una automatización y continúa por la rama correspondiente. */
export function decideApproval(ctx: Ctx, approvalId: string, decision: "approved" | "rejected", comment?: string | null) {
  const ap = parseJson(ctx.db.get<Row>("SELECT * FROM automation_approvals WHERE id=? AND workspace_id=?", approvalId, ctx.ws), ["payload"]);
  if (!ap) throw new Error("Aprobación no encontrada");
  if (ap.status !== "pending") throw new Error("Esta aprobación ya está decidida");
  if (ap.approver_id && ap.approver_id !== ctx.user.id && !ctx.role.permissions.admin) throw new Error("Solo el aprobador (o un administrador) puede decidir");
  ctx.db.update("automation_approvals", String(ap.id), { status: decision, comment: comment ?? null, decided_by: ctx.user.id, decided_at: now() });
  const w = parseJson(ctx.db.get<Row>("SELECT * FROM workflows WHERE id=?", ap.workflow_id), ["trigger", "conditions", "actions"]);
  const p = ap.payload as { then: Action[]; else: Action[]; rest: Action[]; depth: number };
  if (!w) return { ok: true };
  const ectx = executionCtx(ctx, w); if (typeof ectx === "string") throw new Error(ectx);
  const record = loadRecord(ectx, String(ap.object), String(ap.record_id)); if (!record) return { ok: true };
  const st: RunState = { log: [`${decision === "approved" ? "Aprobado" : "Rechazado"} por ${ctx.user.name}${comment ? `: ${comment}` : ""}`], count: 0, depth: p.depth };
  const actions = decision === "approved" ? [...(p.then ?? []), ...(p.rest ?? [])] : [...(p.else ?? [])];
  const status = executeActions(ectx, w, String(ap.object), prepare(ectx, String(ap.object), record), actions, st);
  ctx.db.insert("workflow_runs", { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object: ap.object, record_id: ap.record_id, status, log: st.log, ran_at: now(), actions_count: st.count, trigger_desc: `Aprobación: ${ap.title}`, origin: "automation", depth: p.depth });
  return { ok: true, status, log: st.log };
}

/* ================================================================== planificador de fechas */
function tzOffsetMinutes(tz: string, at: Date): number {
  try { const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])); const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)); return Math.round((local - at.getTime()) / 60000); } catch { return 0; }
}
/** Instante UTC del momento local «fecha a las HH:00» en la zona de la cuenta. */
export function localToUtc(day: string, hour: number, tz: string): Date { const guess = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`); return new Date(guess.getTime() - tzOffsetMinutes(tz, guess) * 60000); }
function dateFieldValue(record: Record<string, unknown>, field: string): string | null {
  const [f, part] = field.split("#");
  const v = fieldValue(record, f!);
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") { const o = v as Row; return String((part === "start" ? o.from : o.to) ?? "") || null; }
  return String(v);
}
export function computeFireAt(ctx: Ctx, t: Trigger, basis: string): Date {
  const hasTime = basis.length > 10 && t.at_hour === undefined;
  let at: Date;
  if (hasTime) at = new Date(basis);
  else { const day = isoDay(offsetDate(new Date(`${basis.slice(0, 10)}T00:00:00Z`), t.offset_days ?? 0, !!t.business_days)); at = localToUtc(day, t.at_hour ?? 8, ctx.settings.timezone || "Europe/Madrid"); return new Date(at.getTime() + (t.offset_hours ?? 0) * 3600000); }
  at = offsetDate(at, t.offset_days ?? 0, !!t.business_days);
  return new Date(at.getTime() + (t.offset_hours ?? 0) * 3600000);
}
function planRecord(ctx: Ctx, w: Row, object: string, record: Record<string, unknown>) {
  const t = w.trigger as Trigger; if (!t.field) return;
  let rec = record;
  if (t.field.startsWith("custom.") && fieldDefs(ctx, object).some((d) => d.key === t.field!.slice(7).split("#")[0] && COMPUTED_TYPES.includes(d.type))) rec = prepare(ctx, object, record);
  const basis = dateFieldValue(rec, t.field);
  ctx.db.run("DELETE FROM automation_schedule WHERE workflow_id=? AND record_id=? AND fired_at IS NULL AND basis != ?", w.id, record.id, basis ?? "");
  if (!basis) return;
  const fire = computeFireAt(ctx, t, basis);
  if (Number.isNaN(fire.getTime()) || fire.getTime() <= Date.now()) return; // sin efecto retroactivo
  ctx.db.run("INSERT OR IGNORE INTO automation_schedule (id, workspace_id, workflow_id, object, record_id, basis, fire_at) VALUES (?,?,?,?,?,?,?)", id(), ctx.ws, w.id, object, record.id, basis, fire.toISOString());
}
export function planWorkflow(ctx: Ctx, w: Row) {
  ctx.db.run("DELETE FROM automation_schedule WHERE workflow_id=? AND fired_at IS NULL", w.id);
  const t = w.trigger as Trigger;
  if (t.type !== "date_arrives" || !w.active || !t.object) return 0;
  const table = OBJECT_TABLE[t.object]; if (!table) return 0;
  const soft = ["contacts", "companies", "deals", "contracts", "custom_records"].includes(table) ? " AND deleted_at IS NULL" : "";
  const only = table === "custom_records" ? " AND object_key=?" : "";
  let n = 0;
  for (const r of ctx.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE workspace_id=?${soft}${only} LIMIT 5000`, ...(only ? [ctx.ws, t.object] : [ctx.ws]))) { const rec = loadRecord(ctx, t.object, r.id); if (rec) { planRecord(ctx, w, t.object, rec); n++; } }
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM automation_schedule WHERE workflow_id=? AND fired_at IS NULL", w.id)?.n ?? n;
}
function planForEvent(ctx: Ctx, ev: CrmEvent) {
  if (!/\.(created|updated|stage_changed|status_changed|won|lost|resolved|activated|amendment_activated|auto_renewed)$/.test(ev.type)) return;
  const wfs = ctx.db.all<Row>("SELECT * FROM workflows WHERE workspace_id=? AND active=1 AND trigger LIKE '%date_arrives%'", ctx.ws).map((w) => parseJson(w, ["trigger", "conditions", "actions"]) as Row);
  for (const w of wfs) { const t = w.trigger as Trigger; if (t.type === "date_arrives" && t.object === ev.object) planRecord(ctx, w, ev.object, ev.record); }
}
/** Llamado cada minuto: dispara las fechas vencidas y los periodos. */
export function runDueSchedules(ctx: Ctx) {
  for (const s of ctx.db.all<Row>("SELECT * FROM automation_schedule WHERE workspace_id=? AND fired_at IS NULL AND fire_at <= ? ORDER BY fire_at LIMIT 200", ctx.ws, now())) {
    ctx.db.update("automation_schedule", String(s.id), { fired_at: now() });
    const w = parseJson(ctx.db.get<Row>("SELECT * FROM workflows WHERE id=? AND active=1", s.workflow_id), ["trigger", "conditions", "actions"]);
    if (!w) continue;
    const rec = loadRecord(ctx, String(s.object), String(s.record_id)); if (!rec) continue;
    const cur = dateFieldValue(prepare(ctx, String(s.object), rec), String((w.trigger as Trigger).field));
    if (cur !== s.basis) { planRecord(ctx, w, String(s.object), rec); continue; }
    runWorkflow(ctx, w, rec, { type: `${s.object}.date_arrived`, object: s.object as never, record: rec, meta: { origin: "system", field: (w.trigger as Trigger).field } }, { force: true });
  }
  runPeriodic(ctx);
}
function periodKey(t: Trigger, local: Date): string | null {
  const day = local.toISOString().slice(0, 10), hour = local.getUTCHours();
  if (hour < (t.at_hour ?? 8)) return null;
  if (t.period === "week") { if (local.getUTCDay() !== (t.weekday ?? 1)) return null; return `w:${day}`; }
  if (t.period === "month") { if (local.getUTCDate() !== (t.monthday ?? 1)) return null; return `m:${day.slice(0, 7)}`; }
  return `d:${day}`;
}
function runPeriodic(ctx: Ctx) {
  const wfs = ctx.db.all<Row>("SELECT * FROM workflows WHERE workspace_id=? AND active=1 AND trigger LIKE '%every_period%'", ctx.ws).map((w) => parseJson(w, ["trigger", "conditions", "actions"]) as Row);
  if (!wfs.length) return;
  const nowD = new Date(); const local = new Date(nowD.getTime() + tzOffsetMinutes(ctx.settings.timezone || "Europe/Madrid", nowD) * 60000);
  for (const w of wfs) {
    const t = w.trigger as Trigger; if (t.type !== "every_period" || !t.object) continue;
    const key = periodKey(t, local); if (!key || key === w.last_period_key) continue;
    ctx.db.update("workflows", String(w.id), { last_period_key: key });
    enrollAll(ctx, w, t.object, `${t.object}.period`);
  }
}
function enrollAll(ctx: Ctx, w: Row, object: string, evType: string, extraFilter?: (r: Record<string, unknown>) => boolean) {
  const table = OBJECT_TABLE[object]; if (!table) return;
  let where: { sql: string; params: unknown[] } = { sql: "1=1", params: [] };
  const flat = w.conditions as FilterGroup;
  if ((flat.conditions ?? []).every((c) => !(c as CondNode).conditions && !String((c as CondNode).field ?? "").startsWith("_"))) { try { where = buildWhere(object, flat, "t"); } catch { /* condiciones sobre campos calculados: se evalúan en memoria */ } }
  const soft = ["contacts", "companies", "deals", "contracts", "custom_records"].includes(table) ? " AND t.deleted_at IS NULL" : "";
  const only = table === "custom_records" ? " AND t.object_key=?" : "";
  for (const r of ctx.db.all<{ id: string }>(`SELECT t.id FROM ${table} t WHERE t.workspace_id=? AND ${where.sql}${soft}${only} LIMIT 1000`, ctx.ws, ...where.params, ...(only ? [object] : []))) {
    if (ctx.db.get("SELECT id FROM workflow_runs WHERE workflow_id=? AND record_id=? AND ran_at >= ? AND status != 'skipped'", w.id, r.id, now().slice(0, 10))) continue;
    const rec = loadRecord(ctx, object, r.id); if (!rec) continue;
    if (extraFilter && !extraFilter(rec)) continue;
    runWorkflow(ctx, w, rec, { type: evType, object: object as never, record: rec, meta: { origin: "system" } }, { force: true });
  }
}
/** Diario: «la fecha ha pasado», «no cambia en N días» y el programado heredado. */
export function runScheduledDaily(ctx: Ctx) {
  for (const w of activeWorkflows(ctx)) {
    const t = w.trigger as Trigger; const object = t.object ?? "contact";
    if (t.type === "scheduled_daily") enrollAll(ctx, w, object, `${object}.scheduled`);
    if (t.type === "date_passed" && t.field) enrollAll(ctx, w, object, `${object}.date_passed`, (rec) => { const v = dateFieldValue(prepare(ctx, object, rec), t.field!); return !!v && v.slice(0, 10) < now().slice(0, 10); });
    if (t.type === "status_unchanged" && t.field) {
      const days = t.days ?? 7;
      enrollAll(ctx, w, object, `${object}.unchanged`, (rec) => {
        if (t.value && !valueIs(ctx, object, t.field!, fieldValue(rec, t.field!), t.value)) return false;
        const last = ctx.db.get<{ at: string }>("SELECT MAX(created_at) at FROM audit_log WHERE object=? AND record_id=? AND changes LIKE ?", object, rec.id, `%"${t.field}"%`)?.at ?? String(rec.created_at ?? now());
        if (Date.now() - new Date(last).getTime() < days * 86400000) return false;
        return !ctx.db.get("SELECT id FROM workflow_runs WHERE workflow_id=? AND record_id=? AND status='ok' AND ran_at > ?", w.id, rec.id, last);
      });
    }
  }
  const keep = ctx.settings.automation_history_days ?? 365;
  if (keep > 0) ctx.db.run("DELETE FROM workflow_runs WHERE workspace_id=? AND ran_at < ?", ctx.ws, new Date(Date.now() - keep * 86400000).toISOString());
  ctx.db.run("DELETE FROM automation_schedule WHERE workspace_id=? AND fired_at IS NOT NULL AND fired_at < ?", ctx.ws, new Date(Date.now() - 90 * 86400000).toISOString());
}

/* ================================================================== simulación (dry run) */
export function simulate(ctx: Ctx, w: WorkflowInput, object: string, rid: string) {
  const record = loadRecord(ctx, object, rid);
  if (!record) return { found: false, matches: false, actions: [] as string[], actions_count: 0 };
  const rec = prepare(ctx, object, record);
  const ok = matchesGroup(rec, w.conditions as CondNode);
  const st: RunState = { log: [], count: 0, depth: 1, dry: true };
  if (ok) executeActions(ctx, { id: "sim", name: w.name } as Row, object, rec, w.actions as Action[], st);
  const t = w.trigger;
  const next = t.type === "date_arrives" && t.field ? (() => { const b = dateFieldValue(rec, t.field!); return b ? computeFireAt(ctx, t, b).toISOString() : null; })() : null;
  return { found: true, matches: ok, record_name: recordName(object, rec as Row), actions: ok ? st.log : (w.actions as Action[]).map((a) => describeAction(ctx, a, tplCtx(ctx, object, rec))), actions_count: ok ? st.count : 0, next_fire_at: next, computed: Object.fromEntries(Object.entries((rec._text as Row | undefined)?.custom ?? {})) };
}
function describeAction(ctx: Ctx, a: Action, t: Record<string, unknown>): string {
  const s = (k: string, d = "") => String(a[k] ?? d);
  switch (a.type) {
    case "create_task": return `Crear tarea «${renderTemplate(s("title", "Seguimiento"), t)}» en ${a.due_in_days ?? 1} día(s) para ${s("assignee", "owner")}`;
    case "create_subitems": return `Crear ${s("titles").split("\n").filter((x) => x.trim()).length} subelemento(s): ${s("titles").split("\n").filter(Boolean).join(" · ")}`;
    case "notify": return `Notificar a ${s("to", "owner")}: ${renderTemplate(s("title"), t)}`;
    case "send_email": return `Enviar email a ${s("to", "contact")}: ${renderTemplate(s("title"), t)}`;
    case "update_field": return `Poner ${s("field")} = ${renderTemplate(s("value"), t)}`;
    case "set_date": return `Poner ${s("field")} = ${s("mode", "today") === "field" ? s("source_field") : s("mode", "today") === "fixed" ? s("value") : "hoy"} ${Number(a.days ?? 0) >= 0 ? "+" : ""}${a.days ?? 0} días${a.business_days ? " hábiles" : ""}`;
    case "shift_date": return `Empujar ${s("field")} ${a.days ?? 1} días`;
    case "set_number": return `${s("field")}: ${s("mode", "set")} ${s("value")}`;
    case "assign": case "change_owner": return `Asignar (${s("mode", "fijo")}) ${s("field") || "propietario"}`;
    case "create_record": return `Crear elemento en ${OBJECT_LABEL[s("object", "task")] ?? s("object")}${a.connect === false ? "" : " y conectarlo"}`;
    case "update_related": return `Actualizar ${RELATIONS[String(t.__object ?? "")]?.[s("relation")]?.label ?? s("relation")}: ${s("field")} = ${s("value")}`;
    case "branch": return `Si (condiciones) → ${(a.then ?? []).length} acción(es); si no → ${(a.else ?? []).length}`;
    case "request_approval": return `Pedir aprobación a ${s("approver", "manager")}`;
    case "delay": return `Esperar ${a.days ?? 0} d ${a.hours ?? 0} h ${a.minutes ?? 0} min`;
    default: return ACTION_INFO[a.type]?.label ?? a.type;
  }
}

export { emit };
export type { FieldDef };
void statusLabels;
