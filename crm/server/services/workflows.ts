/**
 * Workflow engine (8.1): TRIGGER -> CONDITIONS -> ACTIONS, with delays, re-enrollment control and run history.
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now, renderTemplate, addDays } from "../lib/util.js";
import { matches, buildWhere, type FilterGroup } from "../lib/filters.js";
import { onEvent, emit, type CrmEvent } from "./events.js";
import { createTask } from "./tasks.js";
import { notify } from "./notifications.js";
import { sendMail } from "./email.js";
import { updateContact, getContact } from "./contacts.js";
import { updateCompany } from "./companies.js";
import { updateDeal, moveStage, createDeal, getDeal } from "./deals.js";
import { updateTicket } from "./tickets.js";
import { getContract, updateContract } from "./clm.js";
import { pickAssignee } from "./assignment.js";
import { logActivity } from "./activities.js";
import { ownerScope } from "../lib/permissions.js";

export const TRIGGER_TYPES = ["record_created", "record_updated", "field_changed", "stage_changed", "deal_won", "deal_lost", "form_submitted", "task_overdue", "deal_inactive", "deal_stale", "score_threshold", "ticket_created", "ticket_sla_risk", "email_opened", "quote_viewed", "quote_accepted", "scheduled_daily", "webhook_in"] as const;
export const ACTION_TYPES = ["create_task", "notify", "send_email", "update_field", "change_owner", "change_stage", "add_tag", "add_to_list", "add_score", "call_webhook", "create_deal", "log_note", "delay"] as const;

export const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  object: z.enum(["contact", "company", "deal", "task", "ticket", "quote", "contract"]).optional(),
  field: z.string().optional(),
  value: z.string().optional(),
  stage_id: z.string().optional(),
  pipeline_id: z.string().optional(),
  form_id: z.string().optional(),
  days: z.number().int().min(1).optional(),
  min: z.number().optional(),
  hours: z.number().optional(),
});
export const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  // generic params
  title: z.string().optional(),
  body: z.string().optional(),
  task_type: z.string().optional(),
  due_in_days: z.number().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(), // owner | manager | user:<id> | creator
  to: z.string().optional(), // owner | manager | user:<id> | contact | team:<id>
  template_id: z.string().optional(),
  field: z.string().optional(),
  value: z.string().optional(),
  user_id: z.string().optional(),
  team_id: z.string().optional(),
  mode: z.string().optional(), // for change_owner: fixed | round_robin | least_loaded
  stage_id: z.string().optional(),
  tag: z.string().optional(),
  list_id: z.string().optional(),
  points: z.number().optional(),
  url: z.string().optional(),
  pipeline_id: z.string().optional(),
  name: z.string().optional(),
  minutes: z.number().optional(),
  days: z.number().optional(),
});
export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  trigger: triggerSchema,
  conditions: z.object({ logic: z.enum(["and", "or"]).default("and"), conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.any().optional() })).default([]) }).default({ logic: "and", conditions: [] }),
  actions: z.array(actionSchema).default([]),
  active: z.boolean().optional(),
  allow_reenroll: z.boolean().optional(),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;
type Action = z.infer<typeof actionSchema>;
type Trigger = z.infer<typeof triggerSchema>;

const EVENT_TO_TRIGGER: Record<string, string[]> = {
  created: ["record_created"], updated: ["record_updated", "field_changed", "score_threshold"], stage_changed: ["stage_changed"], won: ["deal_won"], lost: ["deal_lost"],
  submitted: ["form_submitted"], overdue: ["task_overdue"], inactive: ["deal_inactive"], stale: ["deal_stale"], sla_risk: ["ticket_sla_risk"], opened: ["email_opened"], viewed: ["quote_viewed"], accepted: ["quote_accepted"], webhook_in: ["webhook_in"],
};

function triggerMatches(t: Trigger, ev: CrmEvent): boolean {
  const kind = ev.type.split(".")[1] ?? "";
  const candidates = EVENT_TO_TRIGGER[kind] ?? [];
  if (!candidates.includes(t.type)) return false;
  if (t.type === "ticket_created") return ev.type === "ticket.created";
  if (t.object && t.object !== ev.object && !["form_submitted", "email_opened", "quote_viewed", "quote_accepted", "deal_won", "deal_lost", "stage_changed", "deal_inactive", "deal_stale", "task_overdue", "ticket_sla_risk", "webhook_in"].includes(t.type)) return false;
  switch (t.type) {
    case "record_created": return ev.type === `${t.object ?? ev.object}.created`;
    case "record_updated": return ev.type === `${t.object ?? ev.object}.updated`;
    case "field_changed": {
      if (!t.field || !ev.changes?.[t.field]) return false;
      if (t.value !== undefined && t.value !== "") return String(ev.changes[t.field]?.[1] ?? "") === t.value;
      return true;
    }
    case "stage_changed":
      if (t.pipeline_id && ev.record.pipeline_id !== t.pipeline_id) return false;
      if (t.stage_id && ev.record.stage_id !== t.stage_id) return false;
      return true;
    case "form_submitted": return !t.form_id || ev.meta?.form_id === t.form_id;
    case "score_threshold": {
      const ch = ev.changes?.score;
      if (!ch) return false;
      const min = t.min ?? 50;
      return Number(ch[0] ?? 0) < min && Number(ch[1] ?? 0) >= min;
    }
    case "deal_inactive": return (ev.meta?.days as number | undefined) === undefined || (t.days ?? 7) <= (ev.meta?.days as number);
    default: return true;
  }
}

export function registerWorkflowEngine() {
  onEvent((ctx, ev) => runForEvent(ctx, ev));
}

export function runForEvent(ctx: Ctx, ev: CrmEvent) {
  const wfs = ctx.db.all<Row>("SELECT * FROM workflows WHERE workspace_id=? AND active=1", ctx.ws);
  for (const w of wfs) {
    parseJson(w, ["trigger", "conditions", "actions"]);
    const t = w.trigger as Trigger;
    if (!triggerMatches(t, ev)) continue;
    runWorkflow(ctx, w, ev.record, ev);
  }
}

export function runWorkflow(ctx: Ctx, w: Row, record: Record<string, unknown>, ev?: CrmEvent, opts: { force?: boolean } = {}) {
  const recordId = String(record.id ?? "");
  const object = (ev?.object ?? (w.trigger as Trigger).object ?? "contact") as string;
  const log: string[] = [];
  if (!opts.force && !w.allow_reenroll) {
    const prior = ctx.db.get("SELECT id FROM workflow_runs WHERE workflow_id=? AND record_id=? AND status='ok'", w.id, recordId);
    if (prior) return; // already enrolled once
  }
  if (!matches(record, w.conditions as FilterGroup)) {
    ctx.db.insert("workflow_runs", { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object, record_id: recordId, status: "skipped", log: ["Las condiciones no se cumplen"], ran_at: now() });
    return;
  }
  const actions = (w.actions as Action[]) ?? [];
  const status = executeActions(ctx, w, object, record, actions, log, (ev?.depth ?? 0) + 1);
  ctx.db.insert("workflow_runs", { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object, record_id: recordId, status, log, ran_at: now() });
  ctx.db.run("UPDATE workflows SET runs=runs+1, last_run_at=? WHERE id=?", now(), w.id);
}

/** Executes actions sequentially. A `delay` action schedules the remaining actions as a job. */
export function executeActions(ctx: Ctx, w: Row, object: string, record: Record<string, unknown>, actions: Action[], log: string[], depth: number): "ok" | "error" {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    try {
      if (a.type === "delay") {
        const ms = ((a.days ?? 0) * 1440 + (a.minutes ?? 0)) * 60000;
        const rest = actions.slice(i + 1);
        if (rest.length) {
          ctx.db.insert("scheduled_jobs", { id: id(), workspace_id: ctx.ws, kind: "workflow_actions", payload: { workflow_id: w.id, object, record_id: record.id, actions: rest, depth }, run_at: new Date(Date.now() + ms).toISOString() });
          log.push(`Esperar ${a.days ?? 0}d ${a.minutes ?? 0}min; ${rest.length} acciones programadas`);
        }
        return "ok";
      }
      runAction(ctx, object, record, a, log, depth);
    } catch (e) {
      log.push(`Error en ${a.type}: ${(e as Error).message}`);
      return "error";
    }
  }
  return "ok";
}

function resolveUser(ctx: Ctx, spec: string | undefined, record: Record<string, unknown>): string | null {
  if (!spec || spec === "owner") return (record.owner_id as string | null) ?? (record.assignee_id as string | null) ?? ctx.user.id;
  if (spec === "creator") return (record.created_by as string | null) ?? ctx.user.id;
  if (spec === "manager") {
    const owner = (record.owner_id as string | null) ?? (record.assignee_id as string | null);
    const team = ctx.db.get<{ manager_id: string | null }>("SELECT t.manager_id FROM users u JOIN teams t ON t.id=u.team_id WHERE u.id=?", owner ?? "");
    return team?.manager_id ?? null;
  }
  if (spec.startsWith("user:")) return spec.slice(5);
  return null;
}

function tplCtx(ctx: Ctx, object: string, record: Record<string, unknown>) {
  const owner = ctx.db.get<Row>("SELECT name, email, email_signature FROM users WHERE id=?", (record.owner_id as string | null) ?? "");
  const name = object === "contact" ? `${record.first_name ?? ""} ${record.last_name ?? ""}`.trim() : String(record.name ?? record.subject ?? record.title ?? "");
  return { ...record, nombre: record.first_name ?? name, apellidos: record.last_name ?? "", name, empresa: (record.company as Row | null)?.name ?? record.company_name ?? "", importe: record.amount ?? "", propietario: { nombre: owner?.name ?? "", email: owner?.email ?? "", firma: owner?.email_signature ?? "" }, owner: { name: owner?.name ?? "", signature: owner?.email_signature ?? "" }, company: record.company ?? {}, contact: record, deal: record };
}

function links(object: string, record: Record<string, unknown>) {
  return {
    contact_id: object === "contact" ? (record.id as string) : ((record.contact_id as string | null) ?? null),
    company_id: object === "company" ? (record.id as string) : ((record.company_id as string | null) ?? null),
    deal_id: object === "deal" ? (record.id as string) : ((record.deal_id as string | null) ?? null),
    ticket_id: object === "ticket" ? (record.id as string) : null,
  };
}

function runAction(ctx: Ctx, object: string, record: Record<string, unknown>, a: Action, log: string[], depth: number) {
  const t = tplCtx(ctx, object, record);
  const rid = String(record.id);
  switch (a.type) {
    case "create_task": {
      const assignee = resolveUser(ctx, a.assignee, record);
      const task = createTask(ctx, { title: renderTemplate(a.title ?? "Seguimiento", t), type: (a.task_type as "call") ?? "followup", due_at: addDays(now(), a.due_in_days ?? 1), priority: (a.priority as "high") ?? "normal", assignee_id: assignee, description: a.body ? renderTemplate(a.body, t) : null, ...links(object, record) });
      log.push(`Tarea creada: ${task.title}`);
      break;
    }
    case "notify": {
      const title = renderTemplate(a.title ?? "Aviso del CRM", t);
      const body = a.body ? renderTemplate(a.body, t) : undefined;
      const link = object === "contact" ? `/contactos/${rid}` : object === "deal" ? `/negocios/${rid}` : object === "company" ? `/empresas/${rid}` : object === "ticket" ? `/tickets/${rid}` : undefined;
      if (a.to?.startsWith("team:")) {
        for (const u of ctx.db.all<{ id: string }>("SELECT id FROM users WHERE team_id=? AND active=1", a.to.slice(5))) notify(ctx.db, ctx.ws, u.id, { type: "workflow", title, body, link });
        log.push(`Aviso enviado al equipo`);
      } else {
        const uid = resolveUser(ctx, a.to, record);
        notify(ctx.db, ctx.ws, uid, { type: "workflow", title, body, link });
        log.push(`Aviso enviado${uid ? "" : " (sin destinatario)"}: ${title}`);
      }
      break;
    }
    case "send_email": {
      const tpl = a.template_id ? ctx.db.get<Row>("SELECT * FROM email_templates WHERE id=? AND workspace_id=?", a.template_id, ctx.ws) : null;
      const subject = renderTemplate((tpl?.subject as string | undefined) ?? a.title ?? "", t);
      const body = renderTemplate((tpl?.body as string | undefined) ?? a.body ?? "", t);
      let to: string | null = null, contactId: string | null = null;
      if (!a.to || a.to === "contact") {
        const c = object === "contact" ? record : record.contact_id ? ctx.db.get<Row>("SELECT * FROM contacts WHERE id=?", record.contact_id) : object === "deal" ? ctx.db.get<Row>("SELECT c.* FROM contacts c JOIN deal_contacts dc ON dc.contact_id=c.id WHERE dc.deal_id=? LIMIT 1", rid) : null;
        if (c?.do_not_contact) { log.push("Email omitido: el contacto no desea ser contactado"); break; }
        to = (c?.email as string | null) ?? null; contactId = (c?.id as string | null) ?? null;
      } else {
        const uid = resolveUser(ctx, a.to, record);
        to = uid ? (ctx.db.get<{ email: string }>("SELECT email FROM users WHERE id=?", uid)?.email ?? null) : null;
      }
      if (!to) { log.push("Email omitido: sin dirección"); break; }
      const act = contactId ? logActivity(ctx, { type: "email", subject, body, direction: "outbound", contact_id: contactId, deal_id: object === "deal" ? rid : null, meta: { automated: true } }) : null;
      void sendMail(ctx.db, ctx.ws, { to, subject, html: body.replace(/\n/g, "<br/>"), contactId, userId: ctx.user.id, activityId: (act?.id as string | undefined) ?? null }).catch((e) => console.error("[workflow email]", e));
      log.push(`Email enviado a ${to}: ${subject}`);
      break;
    }
    case "update_field": {
      if (!a.field) throw new Error("Falta el campo");
      const value = renderTemplate(a.value ?? "", t);
      const patch: Record<string, unknown> = a.field.startsWith("custom.") ? { custom: { [a.field.slice(7)]: value } } : { [a.field]: coerceValue(value) };
      applyPatch(ctx, object, rid, patch, depth);
      log.push(`Campo ${a.field} = ${value}`);
      break;
    }
    case "change_owner": {
      let uid: string | null = null;
      if (a.mode === "round_robin" || a.mode === "least_loaded") uid = pickAssignee(ctx.db, ctx.ws, { mode: a.mode, team_id: a.team_id ?? null }, `wf:${a.team_id ?? "all"}`);
      else uid = a.user_id ?? null;
      if (!uid) throw new Error("No hay usuario al que asignar");
      applyPatch(ctx, object, rid, object === "ticket" || object === "task" ? { assignee_id: uid } : { owner_id: uid }, depth);
      notify(ctx.db, ctx.ws, uid, { type: "assigned", title: `Se te ha asignado: ${t.name}`, link: object === "contact" ? `/contactos/${rid}` : object === "deal" ? `/negocios/${rid}` : undefined });
      log.push(`Propietario cambiado a ${uid}`);
      break;
    }
    case "change_stage": {
      if (object !== "deal" || !a.stage_id) throw new Error("Solo aplica a negocios");
      moveStage(ctx, rid, a.stage_id, { depth, skipValidation: true });
      log.push(`Etapa cambiada`);
      break;
    }
    case "add_tag": {
      const tags = Array.isArray(record.tags) ? [...(record.tags as string[])] : [];
      if (a.tag && !tags.includes(a.tag)) { tags.push(a.tag); applyPatch(ctx, object, rid, { tags }, depth); }
      log.push(`Etiqueta añadida: ${a.tag}`);
      break;
    }
    case "add_to_list": {
      if (!a.list_id) throw new Error("Falta la lista");
      ctx.db.run("INSERT OR IGNORE INTO list_members (list_id, record_id, added_at) VALUES (?,?,?)", a.list_id, rid, now());
      log.push("Añadido a la lista");
      break;
    }
    case "add_score": {
      if (object !== "contact") throw new Error("Solo aplica a contactos");
      ctx.db.run("UPDATE contacts SET score=MIN(100, MAX(0, score + ?)) WHERE id=?", a.points ?? 0, rid);
      log.push(`Puntuación ${(a.points ?? 0) >= 0 ? "+" : ""}${a.points ?? 0}`);
      break;
    }
    case "call_webhook": {
      if (!a.url) throw new Error("Falta la URL");
      const payload = JSON.stringify({ workflow: true, object, record, at: now() });
      void fetch(a.url, { method: "POST", headers: { "content-type": "application/json" }, body: payload }).catch((e) => console.error("[workflow webhook]", e));
      log.push(`Webhook llamado: ${a.url}`);
      break;
    }
    case "create_deal": {
      const contactId = object === "contact" ? rid : (record.contact_id as string | null);
      const companyId = object === "company" ? rid : (record.company_id as string | null);
      const d = createDeal(ctx, { name: renderTemplate(a.name ?? "Negocio {{name}}", t), pipeline_id: a.pipeline_id, company_id: companyId ?? null, owner_id: (record.owner_id as string | null) ?? ctx.user.id, contacts: contactId ? [{ contact_id: contactId, role: "decision_maker" }] : [] }, { depth });
      log.push(`Negocio creado: ${d.name}`);
      break;
    }
    case "log_note": {
      logActivity(ctx, { type: "note", subject: renderTemplate(a.title ?? "Nota automática", t), body: a.body ? renderTemplate(a.body, t) : null, ...links(object, record), meta: { automated: true } });
      log.push("Nota registrada");
      break;
    }
    default:
      throw new Error(`Acción desconocida: ${(a as Action).type}`);
  }
}

function coerceValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function applyPatch(ctx: Ctx, object: string, rid: string, patch: Record<string, unknown>, depth: number) {
  switch (object) {
    case "contact": updateContact(ctx, rid, patch, { depth }); break;
    case "company": updateCompany(ctx, rid, patch, { depth }); break;
    case "deal": updateDeal(ctx, rid, patch, { depth }); break;
    case "ticket": updateTicket(ctx, rid, patch, { depth }); break;
    case "contract": updateContract(ctx, rid, patch as never); break;
    default: throw new Error(`No se puede actualizar ${object}`);
  }
}

/** Continue a delayed workflow (called by the scheduler). */
export function resumeActions(ctx: Ctx, payload: { workflow_id: string; object: string; record_id: string; actions: Action[]; depth: number }) {
  const w = ctx.db.get<Row>("SELECT * FROM workflows WHERE id=?", payload.workflow_id);
  if (!w || !w.active) return;
  const record = loadRecord(ctx, payload.object, payload.record_id);
  if (!record) return;
  const log: string[] = ["Continuación tras espera"];
  const status = executeActions(ctx, w, payload.object, record, payload.actions, log, payload.depth);
  ctx.db.insert("workflow_runs", { id: id(), workspace_id: ctx.ws, workflow_id: w.id, object: payload.object, record_id: payload.record_id, status, log, ran_at: now() });
}

export function loadRecord(ctx: Ctx, object: string, rid: string): Record<string, unknown> | null {
  try {
    if (object === "contact") { const c = getContact(ctx, rid); const company = c.company_id ? ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.company_id) : null; return { ...c, company }; }
    if (object === "deal") { const d = getDeal(ctx, rid); const company = d.company_id ? ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", d.company_id) : null; return { ...d, company }; }
    if (object === "company") return parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", rid), ["tags", "custom"]) ?? null;
    if (object === "ticket") return ctx.db.get<Row>("SELECT * FROM tickets WHERE id=?", rid) ?? null;
    if (object === "task") return ctx.db.get<Row>("SELECT * FROM tasks WHERE id=?", rid) ?? null;
    if (object === "contract") { const c = getContract(ctx, rid); const company = c.counterparty_company_id ? ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.counterparty_company_id) : null; return { ...c, company }; }
  } catch { return null; }
  return null;
}

/** Daily scheduled workflows: enroll every record matching the conditions (once per day per record). */
export function runScheduledDaily(ctx: Ctx) {
  const wfs = ctx.db.all<Row>("SELECT * FROM workflows WHERE workspace_id=? AND active=1", ctx.ws);
  for (const w of wfs) {
    parseJson(w, ["trigger", "conditions", "actions"]);
    const t = w.trigger as Trigger;
    if (t.type !== "scheduled_daily") continue;
    const object = t.object ?? "contact";
    const table = ({ contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", task: "tasks", quote: "quotes", contract: "contracts" } as Record<string, string>)[object] ?? "contacts";
    let where: { sql: string; params: unknown[] };
    try { where = buildWhere(object, w.conditions as FilterGroup, "t"); } catch { continue; }
    const scope = ownerScope(ctx, "t.owner_id");
    void scope;
    const rows = ctx.db.all<Row>(`SELECT t.id FROM ${table} t WHERE t.workspace_id=? AND ${where.sql}${["contacts", "companies", "deals", "contracts"].includes(table) ? " AND t.deleted_at IS NULL" : ""} LIMIT 1000`, ctx.ws, ...where.params);
    for (const r of rows) {
      const ranToday = ctx.db.get("SELECT id FROM workflow_runs WHERE workflow_id=? AND record_id=? AND date(ran_at)=date('now')", w.id, r.id);
      if (ranToday) continue;
      const record = loadRecord(ctx, object, r.id as string);
      if (record) runWorkflow(ctx, w, record, { type: `${object}.scheduled`, object: object as CrmEvent["object"], record }, { force: true });
    }
  }
}

/** Simulate a workflow against a record without executing actions (prueba en modo simulación). */
export function simulate(ctx: Ctx, w: WorkflowInput, object: string, rid: string) {
  const record = loadRecord(ctx, object, rid);
  if (!record) return { found: false, matches: false, actions: [] as string[] };
  const ok = matches(record, w.conditions as FilterGroup);
  const t = tplCtx(ctx, object, record);
  return { found: true, matches: ok, record_name: t.name, actions: w.actions.map((a) => describeAction(a, t)) };
}
function describeAction(a: Action, t: Record<string, unknown>): string {
  switch (a.type) {
    case "create_task": return `Crear tarea "${renderTemplate(a.title ?? "Seguimiento", t)}" en ${a.due_in_days ?? 1} día(s) para ${a.assignee ?? "owner"}`;
    case "notify": return `Avisar a ${a.to ?? "owner"}: ${renderTemplate(a.title ?? "", t)}`;
    case "send_email": return `Enviar email (plantilla ${a.template_id ?? "inline"}) a ${a.to ?? "contact"}`;
    case "update_field": return `Poner ${a.field} = ${renderTemplate(a.value ?? "", t)}`;
    case "change_owner": return `Cambiar propietario (${a.mode ?? "fixed"})`;
    case "change_stage": return `Mover a etapa ${a.stage_id}`;
    case "add_tag": return `Añadir etiqueta ${a.tag}`;
    case "add_to_list": return `Añadir a lista ${a.list_id}`;
    case "add_score": return `Sumar ${a.points} puntos`;
    case "call_webhook": return `Llamar a ${a.url}`;
    case "create_deal": return `Crear negocio "${renderTemplate(a.name ?? "", t)}"`;
    case "log_note": return `Registrar nota`;
    case "delay": return `Esperar ${a.days ?? 0} días ${a.minutes ?? 0} min`;
  }
}

export { emit };
