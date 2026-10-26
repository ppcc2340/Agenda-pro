/**
 * CLM configurable por empresa:
 * - ciclo de vida por tipo: estados propios dentro de las fases del motor, transiciones permitidas, campos y
 *   documento obligatorios, quién puede mover y SLA por estado con escalado;
 * - matriz de aprobación: reglas (condiciones anidadas → pasos secuenciales o en paralelo, por usuario, rol,
 *   responsable, legal o grupo «cualquiera/todos»), sustituciones por ausencia y caducidad de aprobaciones;
 * - por tipo: formulario de solicitud, numeración con tokens, obligaciones e hitos por defecto y alertas;
 * - exportación e importación de toda la configuración del CLM.
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson as pjRaw, type Row } from "../db.js";
import { id, now, addDays } from "../lib/util.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { isAdmin } from "../lib/permissions.js";
import { notify } from "./notifications.js";
import { nextCounter } from "./counters.js";
import { audit } from "./audit.js";
import { emit } from "./events.js";
import * as clm from "./clm.js";

/** zod → 400 legible (como `parse` de las rutas). */
function zp<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) { const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })); throw badRequest(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(". "), { issues }); }
  return r.data as z.infer<S>;
}
const pj = (row: Row | undefined, cols: string[]): Row => (pjRaw(row ?? {}, cols) ?? {}) as Row;
const today = () => now().slice(0, 10);
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
/** Fases del motor (no se pueden cambiar: de ellas depende la lógica de firma, activación, renovación…). */
export const PHASES = ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ACTIVE", "EXPIRED", "TERMINATED", "RENEWED", "CANCELLED", "REJECTED", "ON_HOLD", "ARCHIVED"] as const;

/* =============================================================== ajustes */
function settings(ctx: Ctx): Row { const r = ctx.db.get<{ data: string }>("SELECT data FROM clm_settings WHERE workspace_id=?", ctx.ws); try { return r ? JSON.parse(r.data) : {}; } catch { return {}; } }
function saveSettings(ctx: Ctx, patch: Row) { const d = { ...settings(ctx), ...patch }; ctx.db.run("INSERT INTO clm_settings (workspace_id, data) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET data=excluded.data", ctx.ws, JSON.stringify(d)); }
function roleKey(ctx: Ctx): string { return String((ctx.role as unknown as { key?: string }).key ?? ""); }
const FIELD_LABEL: Record<string, string> = { counterparty_company_id: "Contraparte", total_value: "Valor total", annual_value: "Valor anual", effective_date: "Fecha de inicio", end_date: "Fecha de fin", term_months: "Duración", notice_period_days: "Preaviso", department: "Departamento", description: "Objeto", legal_owner_id: "Responsable legal", owner_id: "Propietario", governing_law: "Ley aplicable", jurisdiction: "Jurisdicción", payment_terms_days: "Plazo de pago", deal_id: "Negocio", currency: "Moneda", data_role: "Rol en el tratamiento" };
function fieldLabel(ctx: Ctx, f: string): string {
  if (f.startsWith("custom.")) return ctx.db.get<{ label: string }>("SELECT label FROM custom_fields WHERE workspace_id=? AND object='contract' AND key=?", ctx.ws, f.slice(7))?.label ?? f.slice(7);
  return FIELD_LABEL[f] ?? f;
}
function fieldValue(c: Row, f: string): unknown { if (f.startsWith("custom.")) return ((c.custom as Row) ?? {})[f.slice(7)]; if (f.startsWith("intake.")) return ((c.intake as Row) ?? {})[f.slice(7)]; return c[f]; }
/** Usuario al que se escala: manager, legal_owner, owner, role:clave o user:id. */
function resolveTarget(ctx: Ctx, ref: string | null | undefined, c: Row): string | null {
  const r = ref || "manager";
  if (r === "manager") return clm.managerOf(ctx, c.owner_id as string);
  if (r === "legal_owner") return (c.legal_owner_id as string | null) ?? null;
  if (r === "owner") return (c.owner_id as string | null) ?? null;
  if (r.startsWith("user:")) return r.slice(5);
  if (r.startsWith("role:")) return (clm.usersWithRole(ctx, r.slice(5))[0]?.id as string | undefined) ?? null;
  return null;
}

/* =============================================================== ciclo de vida */
export const stateSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "Clave en minúsculas, números o _"), label: z.string().trim().min(1).max(60), phase: z.enum(PHASES),
  color: z.string().max(20).optional(), optional: z.boolean().optional(), sla_hours: z.number().min(0).max(24 * 365).nullable().optional(), escalate_to: z.string().max(80).nullable().optional(),
  roles: z.array(z.string()).max(20).optional(), required_fields: z.array(z.string()).max(40).optional(), require_document: z.boolean().optional(), description: z.string().max(300).nullable().optional(),
});
export const lcTransitionSchema = z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().max(60).optional(), roles: z.array(z.string()).max(20).optional(), required_fields: z.array(z.string()).max(40).optional(), require_document: z.boolean().optional() });
export const lifecycleSchema = z.object({ states: z.array(stateSchema).max(80), transitions: z.array(lcTransitionSchema).max(300).optional() });
export type StateDef = z.infer<typeof stateSchema>;
export type LcTransition = z.infer<typeof lcTransitionSchema>;
export interface Lifecycle { id: string; type_id: string; states: StateDef[]; transitions: LcTransition[] }

export function getLifecycle(ctx: Ctx, typeId: string | null | undefined): Lifecycle | null {
  const r = (typeId ? ctx.db.get<Row>("SELECT * FROM clm_lifecycles WHERE workspace_id=? AND type_id=?", ctx.ws, typeId) : undefined) ?? ctx.db.get<Row>("SELECT * FROM clm_lifecycles WHERE workspace_id=? AND type_id='*'", ctx.ws);
  if (!r) return null;
  const x = pj(r, ["states", "transitions"]);
  return { id: String(x.id), type_id: String(x.type_id), states: (x.states as StateDef[]) ?? [], transitions: (x.transitions as LcTransition[]) ?? [] };
}
export function saveLifecycle(ctx: Ctx, typeId: string, input: unknown): Lifecycle {
  const b = zp(lifecycleSchema, input);
  const keys = new Set<string>();
  for (const s of b.states) { if (keys.has(s.key)) throw badRequest(`Estado repetido: ${s.key}`); keys.add(s.key); }
  for (const t of b.transitions ?? []) { if (t.from !== "*" && !keys.has(t.from)) throw badRequest(`Transición desde un estado que no existe: ${t.from}`); if (!keys.has(t.to)) throw badRequest(`Transición a un estado que no existe: ${t.to}`); }
  if (typeId !== "*") clm.getType(ctx, typeId);
  // los contratos que estén en un estado eliminado pasan al estado de entrada de su fase
  const prev = ctx.db.get<Row>("SELECT id FROM clm_lifecycles WHERE workspace_id=? AND type_id=?", ctx.ws, typeId);
  if (prev) ctx.db.update("clm_lifecycles", String(prev.id), { states: b.states, transitions: b.transitions ?? [], updated_by: ctx.user.id, updated_at: now() });
  else ctx.db.insert("clm_lifecycles", { id: id(), workspace_id: ctx.ws, type_id: typeId, states: b.states, transitions: b.transitions ?? [], updated_by: ctx.user.id, updated_at: now() });
  const lc = getLifecycle(ctx, typeId === "*" ? null : typeId)!;
  const affected = ctx.db.all<Row>(`SELECT id, status, state_key, type_id FROM contracts WHERE workspace_id=? AND deleted_at IS NULL ${typeId === "*" ? "AND type_id NOT IN (SELECT type_id FROM clm_lifecycles WHERE workspace_id=? AND type_id<>'*')" : "AND type_id=?"}`, ctx.ws, typeId === "*" ? ctx.ws : typeId);
  for (const c of affected) { const cur = lc.states.find((s) => s.key === c.state_key && s.phase === c.status); if (!cur) { const e = entryState(lc, String(c.status)); ctx.db.update("contracts", String(c.id), { state_key: e?.key ?? null, state_entered_at: e ? now() : null, state_due_at: e?.sla_hours ? addDays(now(), e.sla_hours / 24) : null, state_escalated_at: null }); } }
  audit(ctx, "clm_lifecycle", typeId, "update", { states: b.states.length, transitions: (b.transitions ?? []).length });
  return lc;
}
export function deleteLifecycle(ctx: Ctx, typeId: string) {
  ctx.db.run("DELETE FROM clm_lifecycles WHERE workspace_id=? AND type_id=?", ctx.ws, typeId);
  // sin ciclo propio, los contratos vuelven al por defecto (o a solo fases)
  for (const c of ctx.db.all<Row>(`SELECT id, status, type_id FROM contracts WHERE workspace_id=? AND deleted_at IS NULL ${typeId === "*" ? "" : "AND type_id=?"}`, ...(typeId === "*" ? [ctx.ws] : [ctx.ws, typeId]))) { const lc = getLifecycle(ctx, String(c.type_id)); const e = lc ? entryState(lc, String(c.status)) : null; ctx.db.update("contracts", String(c.id), { state_key: e?.key ?? null, state_entered_at: e ? now() : null, state_due_at: null, state_escalated_at: null }); }
  audit(ctx, "clm_lifecycle", typeId, "delete", {});
}
export function statesOfPhase(lc: Lifecycle, phase: string): StateDef[] { return lc.states.filter((s) => s.phase === phase); }
/** Estado al que se entra al llegar a una fase: el primero no opcional (los opcionales se saltan). */
export function entryState(lc: Lifecycle, phase: string): StateDef | null { const ss = statesOfPhase(lc, phase); return ss.find((s) => !s.optional) ?? ss[0] ?? null; }

/** Comprueba roles, campos y documento exigidos para entrar en un estado. Lanza un error legible si no se cumplen. */
function checkGuards(ctx: Ctx, c: Row, lc: Lifecycle, target: StateDef, fromKey: string | null, mode: "move" | "phase") {
  const rules = lc.transitions.filter((t) => t.to === target.key && (t.from === "*" || t.from === fromKey));
  if (mode === "move" && lc.transitions.length && !rules.length) throw conflict(`No hay una transición configurada de «${lc.states.find((s) => s.key === fromKey)?.label ?? "—"}» a «${target.label}»`);
  const roles = [...(target.roles ?? []), ...rules.flatMap((r) => r.roles ?? [])];
  if (roles.length && !isAdmin(ctx) && !roles.includes(roleKey(ctx))) throw forbidden(`Solo ${roles.join(", ")} pueden pasar el contrato a «${target.label}»`);
  const fields = Array.from(new Set([...(target.required_fields ?? []), ...rules.flatMap((r) => r.required_fields ?? [])]));
  const missing = fields.filter((f) => isEmpty(fieldValue(c, f)));
  if (missing.length) throw badRequest(`Para pasar a «${target.label}» falta: ${missing.map((f) => fieldLabel(ctx, f)).join(", ")}`, { missing });
  if ((target.require_document || rules.some((r) => r.require_document)) && !c.current_version_id) throw badRequest(`Para pasar a «${target.label}» el contrato necesita un documento`);
}
/** Antes de un cambio de fase del motor: comprueba el estado de destino (el elegido o el de entrada). */
export function guardPhaseChange(ctx: Ctx, c: Row, phase: string, preferred?: string | null) {
  const lc = getLifecycle(ctx, String(c.type_id)); if (!lc) return;
  const target = (preferred ? statesOfPhase(lc, phase).find((s) => s.key === preferred) : null) ?? entryState(lc, phase);
  if (preferred && !statesOfPhase(lc, phase).some((s) => s.key === preferred)) throw badRequest(`El estado «${preferred}» no pertenece a la fase ${clm.STATUS_LABEL[phase] ?? phase}`);
  if (target) checkGuards(ctx, c, lc, target, (c.state_key as string | null) ?? null, "phase");
}
function enterState(ctx: Ctx, cid: string, s: StateDef | null, actor: "user" | "system" | "external" | "agent" = "user", note?: string | null) {
  ctx.db.update("contracts", cid, { state_key: s?.key ?? null, state_entered_at: s ? now() : null, state_due_at: s?.sla_hours ? addDays(now(), s.sla_hours / 24) : null, state_escalated_at: null, updated_at: now() }); // updated_at: invalida el ETag de la ficha
  if (s) clm.tlog(ctx, cid, "status", `Estado: ${s.label}`, note ?? null, { state: s.key }, actor);
}
/** Lo llama el motor tras cambiar de fase: coloca el contrato en el estado elegido o en el de entrada. */
export function onPhaseChanged(ctx: Ctx, cid: string, phase: string, actor: "user" | "system" | "external" | "agent") {
  const c = ctx.db.get<Row>("SELECT type_id FROM contracts WHERE id=?", cid); if (!c) return;
  const lc = getLifecycle(ctx, String(c.type_id));
  if (!lc) { ctx.db.update("contracts", cid, { state_key: null, state_due_at: null }); return; }
  const preferred = (ctx as unknown as { __clmState?: string | null }).__clmState;
  const s = (preferred ? statesOfPhase(lc, phase).find((x) => x.key === preferred) : null) ?? entryState(lc, phase);
  enterState(ctx, cid, s, actor);
}
/** Mover entre estados de la misma fase (sub-estados). Los cambios de fase se hacen con las acciones del motor. */
export function moveState(ctx: Ctx, cid: string, stateKey: string, note?: string | null): Row {
  const c = clm.getContract(ctx, cid);
  if (c.legal_hold) throw conflict("Contrato bajo bloqueo legal");
  const lc = getLifecycle(ctx, String(c.type_id)); if (!lc) throw badRequest("Este tipo de contrato no tiene un ciclo de vida configurado");
  const target = lc.states.find((s) => s.key === stateKey); if (!target) throw notFound("Estado");
  if (target.phase !== c.status) throw conflict(`«${target.label}» pertenece a la fase ${clm.STATUS_LABEL[target.phase] ?? target.phase}: usa la acción correspondiente del ciclo de vida`);
  if (target.key === c.state_key) return c;
  checkGuards(ctx, c, lc, target, (c.state_key as string | null) ?? null, "move");
  const from = lc.states.find((s) => s.key === c.state_key)?.label ?? "—";
  enterState(ctx, cid, target, "user", note);
  audit(ctx, "contract", cid, "status_change", { state: [c.state_key ?? null, target.key] });
  emit(ctx, { type: "contract.state_changed", object: "contract", record: clm.getContract(ctx, cid), meta: { from: c.state_key ?? null, to: target.key, label: `${from} → ${target.label}` } });
  return clm.getContract(ctx, cid);
}
/** Vista para la ficha: estado actual, estados de la fase y movimientos permitidos. */
export function lifecycleView(ctx: Ctx, c: Row) {
  const lc = getLifecycle(ctx, String(c.type_id)); if (!lc) return null;
  const cur = lc.states.find((s) => s.key === c.state_key) ?? null;
  const phaseStates = statesOfPhase(lc, String(c.status));
  const moves = phaseStates.filter((s) => s.key !== c.state_key && (!lc.transitions.length || lc.transitions.some((t) => t.to === s.key && (t.from === "*" || t.from === c.state_key))));
  return { type_id: lc.type_id, states: lc.states, transitions: lc.transitions, current: cur, phase_states: phaseStates, moves, due_at: c.state_due_at ?? null, escalated_at: c.state_escalated_at ?? null };
}
export function stateLabels(ctx: Ctx): Map<string, Map<string, StateDef>> {
  const out = new Map<string, Map<string, StateDef>>();
  for (const r of ctx.db.all<Row>("SELECT type_id, states FROM clm_lifecycles WHERE workspace_id=?", ctx.ws)) { const ss = (pj(r, ["states"]).states as StateDef[]) ?? []; out.set(String(r.type_id), new Map(ss.map((s) => [s.key, s]))); }
  return out;
}
/** SLA por estado: si se supera, se avisa al destino de escalado (una vez por estancia en el estado). */
export function checkStateSla(ctx: Ctx): number {
  let n = 0;
  for (const c of ctx.db.all<Row>("SELECT * FROM contracts WHERE workspace_id=? AND deleted_at IS NULL AND state_due_at IS NOT NULL AND state_due_at < ? AND state_escalated_at IS NULL", ctx.ws, now())) {
    const lc = getLifecycle(ctx, String(c.type_id)); const s = lc?.states.find((x) => x.key === c.state_key); if (!s) continue;
    const to = resolveTarget(ctx, s.escalate_to, c);
    ctx.db.update("contracts", String(c.id), { state_escalated_at: now() });
    const title = `SLA superado en «${s.label}»: ${c.number}`;
    if (c.owner_id) notify(ctx.db, ctx.ws, c.owner_id as string, { type: "contract", title, body: String(c.title), link: `/contratos/${c.id}` });
    if (to && to !== c.owner_id) notify(ctx.db, ctx.ws, to, { type: "contract", title: `Escalado · ${title}`, body: String(c.title), link: `/contratos/${c.id}` });
    clm.tlog(ctx, String(c.id), "warning", title, to ? `Escalado a ${clm.userNameOf(ctx, to)}` : null, { state: s.key }, "system");
    emit(ctx, { type: "contract.state_sla_breached", object: "contract", record: pj(c, clm.JC), meta: { state: s.key } });
    n++;
  }
  return n;
}

/* =============================================================== matriz de aprobación */
export const CONDITION_FIELDS: Record<string, string> = { value: "Valor total", annual_value: "Valor anual", currency: "Moneda", type_code: "Tipo (código)", risk_level: "Nivel de riesgo", risk_score: "Puntuación de riesgo", paper_origin: "Origen del papel (ours/theirs)", deviations: "Desviaciones del playbook", minor: "Desviaciones menores", major: "Desviaciones mayores", prohibited: "Cláusulas prohibidas", missing: "Cláusulas ausentes", personal_data: "Trata datos personales", outside_eea: "Fuera del EEE", dpa_ok: "DPA conforme", exclusivity: "Exclusividad", department: "Departamento", counterparty_country: "País de la contraparte", term_months: "Duración (meses)", payment_terms_days: "Plazo de pago (días)", payment_model: "Modelo de pago", urgency: "Urgencia", direction: "Dirección (income/expense)", kind: "Clase (master/amendment/renewal)" };
export const CONDITION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_true", "is_false", "empty", "not_empty"] as const;
interface Leaf { field: string; op: (typeof CONDITION_OPS)[number]; value?: unknown }
interface Group { logic: "all" | "any"; conditions: (Leaf | Group)[] }
const leafSchema = z.object({ field: z.string().min(1).max(80), op: z.enum(CONDITION_OPS), value: z.unknown().optional() });
const groupSchema: z.ZodType<Group> = z.lazy(() => z.object({ logic: z.enum(["all", "any"]), conditions: z.array(z.union([leafSchema, groupSchema])).max(40) })) as z.ZodType<Group>;
const approverSchema = z.object({ kind: z.enum(["user", "role", "manager_of_owner", "legal_owner", "owner", "group"]), user_id: z.string().optional(), role: z.string().max(40).optional(), users: z.array(z.string()).max(20).optional(), mode: z.enum(["any", "all"]).optional() });
const stepSchema = z.object({ name: z.string().trim().min(1).max(80), approver: approverSchema, parallel: z.boolean().optional(), sla_hours: z.number().min(1).max(5000).optional(), expiry_days: z.number().int().min(1).max(365).nullable().optional() });
export const ruleSchema = z.object({ name: z.string().trim().min(1).max(120), priority: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional(), type_ids: z.array(z.string()).max(50).optional(), conditions: groupSchema.optional(), steps: z.array(stepSchema).min(1).max(10), reason: z.string().max(240).nullable().optional(), stop: z.boolean().optional() });
export type RuleInput = z.infer<typeof ruleSchema>;

const leaf = (field: string, op: Leaf["op"], value?: unknown): Leaf => ({ field, op, value });
/** Política por defecto (la misma que tenía el CRM antes de ser configurable). */
export const DEFAULT_RULES: RuleInput[] = [
  { name: "Aprobación de negocio", priority: 10, conditions: { logic: "any", conditions: [leaf("value", "gte", 5000), leaf("deviations", "gt", 0)] }, steps: [{ name: "Aprobación de negocio", approver: { kind: "manager_of_owner" }, sla_hours: 48 }], reason: "Valor {value} ≥ 5.000 € o desviaciones del playbook ({deviations})" },
  { name: "Legal", priority: 20, conditions: { logic: "any", conditions: [leaf("minor", "gt", 0), leaf("major", "gt", 0), leaf("missing", "gt", 0), leaf("paper_origin", "eq", "theirs")] }, steps: [{ name: "Legal", approver: { kind: "legal_owner" }, sla_hours: 72 }], reason: "Papel de la contraparte o desviaciones del playbook" },
  { name: "Director legal", priority: 30, conditions: { logic: "any", conditions: [leaf("major", "gt", 0), leaf("prohibited", "gt", 0), leaf("missing", "gt", 0)] }, steps: [{ name: "Director legal", approver: { kind: "role", role: "legal_director" }, sla_hours: 48 }], reason: "{major} desviaciones mayores, {prohibited} prohibidas, {missing} ausentes" },
  { name: "Finanzas", priority: 40, conditions: { logic: "any", conditions: [leaf("value", "gte", 50000), leaf("payment_terms_days", "gt", 60), leaf("payment_model", "eq", "usage")] }, steps: [{ name: "Finanzas", approver: { kind: "role", role: "cfo" }, sla_hours: 48 }], reason: "Valor {value} ≥ 50.000 €, plazo de pago {payment_terms_days} días o pago por uso" },
  { name: "DPO", priority: 50, conditions: { logic: "all", conditions: [leaf("personal_data", "is_true"), { logic: "any", conditions: [leaf("outside_eea", "is_true"), leaf("dpa_ok", "is_false")] }] }, steps: [{ name: "DPO", approver: { kind: "role", role: "dpo" }, sla_hours: 48 }], reason: "Datos personales con transferencia fuera del EEE o sin DPA conforme" },
  { name: "Dirección general", priority: 60, conditions: { logic: "any", conditions: [leaf("value", "gte", 250000), leaf("term_months", "gt", 36), leaf("prohibited", "gt", 0), leaf("exclusivity", "is_true")] }, steps: [{ name: "Dirección general", approver: { kind: "role", role: "ceo" }, sla_hours: 48 }], reason: "Valor {value} ≥ 250.000 €, duración {term_months} meses, cláusula prohibida o exclusividad" },
];
function insertRule(ctx: Ctx, r: RuleInput): string {
  const rid = id();
  ctx.db.insert("clm_approval_rules", { id: rid, workspace_id: ctx.ws, name: r.name, priority: r.priority ?? 100, active: r.active === false ? 0 : 1, type_ids: r.type_ids ?? [], conditions: r.conditions ?? { logic: "all", conditions: [] }, steps: r.steps, reason: r.reason ?? null, stop: r.stop ? 1 : 0, created_at: now(), updated_at: now() });
  return rid;
}
/** La primera vez se siembra la política por defecto como reglas editables. */
export function ensureMatrix(ctx: Ctx) {
  if (settings(ctx).matrix_seeded) return;
  if (!ctx.db.get("SELECT id FROM clm_approval_rules WHERE workspace_id=? LIMIT 1", ctx.ws)) for (const r of DEFAULT_RULES) insertRule(ctx, r);
  saveSettings(ctx, { matrix_seeded: true });
}
export function listRules(ctx: Ctx): Row[] { ensureMatrix(ctx); return ctx.db.all<Row>("SELECT * FROM clm_approval_rules WHERE workspace_id=? ORDER BY priority, name", ctx.ws).map((r) => pj(r, ["type_ids", "conditions", "steps"])); }
export function createRule(ctx: Ctx, input: unknown): Row { ensureMatrix(ctx); const b = zp(ruleSchema, input); validateRuleRefs(ctx, b); const rid = insertRule(ctx, b); audit(ctx, "clm_rule", rid, "create", { name: b.name }); return getRule(ctx, rid); }
export function updateRule(ctx: Ctx, rid: string, input: unknown): Row {
  const b = zp(ruleSchema.partial(), input); getRule(ctx, rid); if (b.steps || b.type_ids) validateRuleRefs(ctx, b as RuleInput);
  ctx.db.update("clm_approval_rules", rid, { name: b.name, priority: b.priority, active: b.active === undefined ? undefined : b.active ? 1 : 0, type_ids: b.type_ids, conditions: b.conditions, steps: b.steps, reason: b.reason, stop: b.stop === undefined ? undefined : b.stop ? 1 : 0, updated_at: now() });
  audit(ctx, "clm_rule", rid, "update", { name: b.name }); return getRule(ctx, rid);
}
export function deleteRule(ctx: Ctx, rid: string) { getRule(ctx, rid); ctx.db.run("DELETE FROM clm_approval_rules WHERE id=? AND workspace_id=?", rid, ctx.ws); audit(ctx, "clm_rule", rid, "delete", {}); }
export function getRule(ctx: Ctx, rid: string): Row { const r = ctx.db.get<Row>("SELECT * FROM clm_approval_rules WHERE id=? AND workspace_id=?", rid, ctx.ws); if (!r) throw notFound("Regla de aprobación"); return pj(r, ["type_ids", "conditions", "steps"]); }
export function reorderRules(ctx: Ctx, ids: string[]) { ids.forEach((rid, i) => ctx.db.run("UPDATE clm_approval_rules SET priority=?, updated_at=? WHERE id=? AND workspace_id=?", (i + 1) * 10, now(), rid, ctx.ws)); }
export function resetRules(ctx: Ctx) { ctx.db.run("DELETE FROM clm_approval_rules WHERE workspace_id=?", ctx.ws); for (const r of DEFAULT_RULES) insertRule(ctx, r); saveSettings(ctx, { matrix_seeded: true }); audit(ctx, "clm_rule", null, "update", { reset: true }); }
function validateRuleRefs(ctx: Ctx, b: Partial<RuleInput>) {
  for (const s of b.steps ?? []) {
    if (s.approver.kind === "user" && !s.approver.user_id) throw badRequest(`Paso «${s.name}»: elige el usuario aprobador`);
    if (s.approver.kind === "role" && !s.approver.role) throw badRequest(`Paso «${s.name}»: elige el rol aprobador`);
    if (s.approver.kind === "group" && !(s.approver.users ?? []).length) throw badRequest(`Paso «${s.name}»: el grupo necesita al menos un usuario`);
    for (const u of [s.approver.user_id, ...(s.approver.users ?? [])].filter(Boolean) as string[]) if (!ctx.db.get("SELECT id FROM users WHERE id=? AND workspace_id=?", u, ctx.ws)) throw badRequest(`Paso «${s.name}»: usuario desconocido`);
  }
}

export type Vars = Record<string, unknown> & { custom?: Row };
/** Variables con las que se evalúan las reglas de un contrato. */
export function approvalVars(ctx: Ctx, c: Row, dev: { level: string; category: string }[]): Vars {
  const cnt = (lvl: string) => dev.filter((d) => d.level === lvl).length;
  const t = clm.getType(ctx, String(c.type_id));
  return {
    value: Number(c.total_value) || 0, annual_value: Number(c.annual_value) || 0, currency: c.currency, type_id: c.type_id, type_code: t.code, term_months: Number(c.term_months) || 0, payment_terms_days: Number(c.payment_terms_days) || 0,
    minor: cnt("minor"), major: cnt("major"), prohibited: cnt("prohibited"), missing: cnt("missing"), deviations: dev.filter((d) => d.level !== "ok" && d.level !== "none").length,
    paper_origin: c.paper_origin, paper_theirs: c.paper_origin === "theirs", personal_data: !!c.contains_personal_data, outside_eea: !!c.counterparty_outside_eea || !!c.international_transfer,
    dpa_ok: dev.some((d) => d.category === "F02" && d.level === "ok"), exclusivity: dev.some((d) => d.category === "H01" && d.level !== "ok"), risk_score: Number(c.risk_score) || 0, risk_level: c.risk_level,
    urgency: c.urgency, direction: t.direction, department: c.department, counterparty_country: c.counterparty_country ?? (c.counterparty_company_id ? ctx.db.get<Row>("SELECT country FROM companies WHERE id=?", c.counterparty_company_id)?.country : null) ?? null,
    payment_model: c.payment_model, kind: c.kind, custom: (c.custom as Row) ?? {},
  };
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean)).map((x) => String(x).toLowerCase());
function evalLeaf(l: Leaf, vars: Vars): boolean {
  const v = l.field.startsWith("custom.") ? (vars.custom ?? {})[l.field.slice(7)] : vars[l.field];
  const s = String(v ?? "").toLowerCase(), w = String(l.value ?? "").toLowerCase();
  switch (l.op) {
    case "eq": return typeof v === "number" ? v === num(l.value) : typeof v === "boolean" ? v === (w === "true" || w === "1" || w === "sí") : s === w;
    case "ne": return !evalLeaf({ ...l, op: "eq" }, vars);
    case "gt": return num(v) > num(l.value); case "gte": return num(v) >= num(l.value);
    case "lt": return num(v) < num(l.value); case "lte": return num(v) <= num(l.value);
    case "in": return list(l.value).includes(s); case "not_in": return !list(l.value).includes(s);
    case "contains": return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()).includes(w) : s.includes(w);
    case "is_true": return !!v && v !== "false" && v !== "0"; case "is_false": return !v || v === "false" || v === "0";
    case "empty": return isEmpty(v); case "not_empty": return !isEmpty(v);
    default: return false;
  }
}
export function evalGroup(g: Group | undefined, vars: Vars): boolean {
  if (!g || !g.conditions?.length) return true;
  const res = g.conditions.map((x) => ("logic" in x ? evalGroup(x as Group, vars) : evalLeaf(x as Leaf, vars)));
  return g.logic === "any" ? res.some(Boolean) : res.every(Boolean);
}
const fmtMoney = (n: unknown, cur = "EUR") => new Intl.NumberFormat("es-ES", { style: "currency", currency: cur || "EUR", maximumFractionDigits: 0 }).format(Number(n) || 0);
function renderReason(tpl: string | null | undefined, vars: Vars, cur: string): string {
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k === "value" || k === "annual_value" ? fmtMoney(vars[k], cur) : String(vars[k] ?? "")));
}
/** Sustituto activo (ausencias) de un aprobador en una fecha. */
export function activeSubstitute(ctx: Ctx, uid: string | null, date = today()): string | null {
  if (!uid) return null;
  return ctx.db.get<{ substitute_id: string }>("SELECT substitute_id FROM clm_delegations WHERE workspace_id=? AND user_id=? AND from_date<=? AND to_date>=? ORDER BY created_at DESC LIMIT 1", ctx.ws, uid, date, date)?.substitute_id ?? null;
}
export interface MatrixStep { name: string; reason: string; approver_user_id: string | null; approver_role: string; sla_hours: number; stage: number; group?: string[]; mode?: "any" | "all"; expiry_days?: number | null; rule_id?: string; substitute_for?: string | null }
/** Pasos de aprobación de un contrato según la matriz configurada. */
export function matrixSteps(ctx: Ctx, c: Row, dev: { level: string; category: string }[]): MatrixStep[] {
  const vars = approvalVars(ctx, c, dev);
  const rules = listRules(ctx).filter((r) => r.active && (!(r.type_ids as string[]).length || (r.type_ids as string[]).includes(String(c.type_id))));
  const steps: MatrixStep[] = [];
  let stage = 0;
  const owner = c.owner_id as string | null;
  const notOwner = (u: string | null, name: string): { user: string | null; note: string } => {
    if (!u || u !== owner) return { user: u, note: "" };
    const alts = [clm.resolveApprover(ctx, "manager_of_requester", c), clm.resolveApprover(ctx, "admin", c), { user: (ctx.db.get<Row>("SELECT id FROM users WHERE workspace_id=? AND active=1 AND is_service=0 AND id<>? ORDER BY created_at LIMIT 1", ctx.ws, owner)?.id as string | undefined) ?? null, role: "user" }];
    const alt = alts.find((x) => x.user && x.user !== owner);
    void name; return alt ? { user: alt.user, note: " (separación de funciones)" } : { user: u, note: "" };
  };
  const substitute = (u: string | null): { user: string | null; sub: string | null; note: string } => { const s = activeSubstitute(ctx, u); return s ? { user: s, sub: u, note: ` (sustituye a ${clm.userNameOf(ctx, u)})` } : { user: u, sub: null, note: "" }; };
  for (const r of rules) {
    if (!evalGroup(r.conditions as Group, vars)) continue;
    const reason = renderReason(r.reason as string | null, vars, String(c.currency ?? "EUR")) || `Regla: ${r.name}`;
    for (const s of (r.steps as z.infer<typeof stepSchema>[])) {
      if (!s.parallel || stage === 0) stage++;
      const sla = s.sla_hours ?? 48;
      const a = s.approver;
      if (a.kind === "group") {
        const members = (a.users ?? []).filter((u) => u !== owner);
        if (!members.length) continue;
        if ((a.mode ?? "any") === "any") { steps.push({ name: s.name, reason, approver_user_id: members[0]!, approver_role: "group", sla_hours: sla, stage, group: members, mode: "any", expiry_days: s.expiry_days ?? null, rule_id: String(r.id) }); }
        else for (const m of members) { const sb = substitute(m); steps.push({ name: s.name, reason: reason + sb.note, approver_user_id: sb.user, approver_role: "group", sla_hours: sla, stage, group: [m], mode: "all", expiry_days: s.expiry_days ?? null, rule_id: String(r.id), substitute_for: sb.sub }); }
        continue;
      }
      const res = a.kind === "user" ? { user: a.user_id ?? null, role: clm.roleKeyOf(ctx, a.user_id) || "user" } : a.kind === "owner" ? { user: owner, role: "owner" } : clm.resolveApprover(ctx, a.kind === "manager_of_owner" ? "manager_of_requester" : a.kind === "legal_owner" ? "legal_owner" : String(a.role), c);
      const sod = notOwner(res.user, s.name);
      const sb = substitute(sod.user);
      const existing = steps.find((x) => !x.group && x.approver_user_id && x.approver_user_id === sb.user);
      if (existing) { existing.name = `${existing.name} + ${s.name}`; existing.reason = `${existing.reason} · ${reason}`; existing.sla_hours = Math.min(existing.sla_hours, sla); if (!s.parallel) stage--; continue; }
      steps.push({ name: s.name, reason: reason + sod.note + sb.note, approver_user_id: sb.user, approver_role: a.kind === "role" ? String(a.role) : res.role, sla_hours: sla, stage, expiry_days: s.expiry_days ?? null, rule_id: String(r.id), substitute_for: sb.sub });
    }
    if (r.stop) break;
  }
  // etapas consecutivas sin huecos
  const order = Array.from(new Set(steps.map((s) => s.stage))).sort((a, b) => a - b);
  for (const s of steps) s.stage = order.indexOf(s.stage) + 1;
  return steps;
}
/** Simula la matriz con un contrato y, opcionalmente, una regla sin guardar. */
export function previewMatrix(ctx: Ctx, cid: string) { const c = clm.getContract(ctx, cid); return { contract: { id: c.id, number: c.number, title: c.title }, steps: clm.computeApprovalSteps(ctx, c) }; }
/** Caducidad de aprobaciones pendientes: se marcan caducadas y el contrato vuelve a revisión. */
export function expireApprovals(ctx: Ctx): number {
  const rows = ctx.db.all<Row>("SELECT a.*, c.number, c.owner_id AS c_owner, c.status AS c_status FROM contract_approvals a JOIN contracts c ON c.id=a.contract_id WHERE a.workspace_id=? AND a.status='pending' AND a.expires_at IS NOT NULL AND a.expires_at < ?", ctx.ws, now());
  const touched = new Set<string>();
  for (const a of rows) {
    ctx.db.update("contract_approvals", String(a.id), { status: "expired", comment: "Caducada sin respuesta" });
    touched.add(String(a.contract_id));
    if (a.c_owner) notify(ctx.db, ctx.ws, a.c_owner as string, { type: "approval", title: `Aprobación caducada: ${a.number}`, body: `${a.step_name}: vuelve a pedir la aprobación`, link: `/contratos/${a.contract_id}?tab=approvals` });
  }
  for (const cid of touched) {
    ctx.db.run("UPDATE contract_approvals SET status='skipped' WHERE contract_id=? AND status='pending'", cid);
    clm.setStatusSystem(ctx, cid, "INTERNAL_REVIEW", "Aprobación caducada: hay que volver a pedirla");
  }
  return rows.length;
}

/* =============================================================== sustituciones */
export const delegationSchema = z.object({ user_id: z.string(), substitute_id: z.string(), from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(200).nullable().optional() });
export function createDelegation(ctx: Ctx, input: unknown): Row {
  const b = zp(delegationSchema, input);
  if (b.user_id === b.substitute_id) throw badRequest("El sustituto debe ser otra persona");
  if (b.to_date < b.from_date) throw badRequest("La fecha de fin es anterior a la de inicio");
  if (!isAdmin(ctx) && b.user_id !== ctx.user.id) throw forbidden("Solo puedes configurar tus propias ausencias");
  for (const u of [b.user_id, b.substitute_id]) if (!ctx.db.get("SELECT id FROM users WHERE id=? AND workspace_id=?", u, ctx.ws)) throw badRequest("Usuario desconocido");
  const did = id();
  ctx.db.insert("clm_delegations", { id: did, workspace_id: ctx.ws, ...b, reason: b.reason ?? null, created_by: ctx.user.id, created_at: now() });
  // las aprobaciones pendientes de la persona ausente pasan al sustituto
  if (b.from_date <= today() && b.to_date >= today()) for (const a of ctx.db.all<Row>("SELECT id, contract_id, step_name FROM contract_approvals WHERE workspace_id=? AND status='pending' AND approver_user_id=?", ctx.ws, b.user_id)) {
    ctx.db.update("contract_approvals", String(a.id), { approver_user_id: b.substitute_id, substitute_for: b.user_id });
    clm.tlog(ctx, String(a.contract_id), "approval", `${a.step_name}: sustitución por ausencia (${clm.userNameOf(ctx, b.user_id)} → ${clm.userNameOf(ctx, b.substitute_id)})`);
    notify(ctx.db, ctx.ws, b.substitute_id, { type: "approval", title: "Aprobación por sustitución", body: String(a.step_name), link: `/contratos/${a.contract_id}?tab=approvals` });
  }
  audit(ctx, "clm_delegation", did, "create", b);
  return ctx.db.get<Row>("SELECT * FROM clm_delegations WHERE id=?", did)!;
}
export function listDelegations(ctx: Ctx): Row[] { return ctx.db.all<Row>("SELECT d.*, u.name AS user_name, s.name AS substitute_name FROM clm_delegations d JOIN users u ON u.id=d.user_id JOIN users s ON s.id=d.substitute_id WHERE d.workspace_id=? ORDER BY d.from_date DESC", ctx.ws); }
export function deleteDelegation(ctx: Ctx, did: string) { const d = ctx.db.get<Row>("SELECT * FROM clm_delegations WHERE id=? AND workspace_id=?", did, ctx.ws); if (!d) throw notFound("Sustitución"); if (!isAdmin(ctx) && d.user_id !== ctx.user.id) throw forbidden("No puedes borrar esta sustitución"); ctx.db.run("DELETE FROM clm_delegations WHERE id=?", did); }

/* =============================================================== numeración */
const slugDept = (d: unknown) => String(d ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6) || "GEN";
export function validateNumberFormat(f: string) { if (!/\{SEQ(:\d)?\}/.test(f)) throw badRequest("El formato de numeración necesita {SEQ} o {SEQ:n}"); if (f.length > 60) throw badRequest("Formato demasiado largo"); }
/** Aplica el formato de numeración del tipo. `consume=false` muestra el siguiente número sin gastarlo. */
export function formatNumber(ctx: Ctx, t: Row, c: { department?: unknown }, consume = true, fmt = t.number_format as string | null): string | null {
  if (!fmt) return null;
  validateNumberFormat(fmt);
  const d = new Date(); const yyyy = String(d.getFullYear()); const dept = slugDept(c.department);
  const yearly = /\{YY(YY)?\}/.test(fmt); const byDept = /\{DEPT\}/.test(fmt);
  const key = `contract:${t.number_prefix}:${yearly ? yyyy : "all"}${byDept ? `:${dept}` : ""}`;
  const seq = consume ? nextCounter(ctx.db, ctx.ws, key) : (ctx.db.get<{ value: number }>("SELECT value FROM counters WHERE workspace_id=? AND key=?", ctx.ws, key)?.value ?? 0) + 1;
  return fmt.replace(/\{TYPE\}/g, String(t.number_prefix)).replace(/\{CODE\}/g, String(t.code)).replace(/\{YYYY\}/g, yyyy).replace(/\{YY\}/g, yyyy.slice(2)).replace(/\{MM\}/g, String(d.getMonth() + 1).padStart(2, "0")).replace(/\{DEPT\}/g, dept)
    .replace(/\{SEQ(?::(\d))?\}/g, (_, n: string | undefined) => String(seq).padStart(Number(n ?? 1), "0"));
}

/* =============================================================== formulario de solicitud por tipo */
export const INTAKE_TYPES = ["text", "textarea", "number", "money", "date", "select", "multiselect", "boolean", "user", "email", "url"] as const;
const MAPPABLE = new Set(["description", "department", "total_value", "annual_value", "effective_date", "end_date", "term_months", "notice_period_days", "payment_terms_days", "governing_law", "jurisdiction", "urgency", "confidentiality", "currency"]);
export const intakeFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Clave en minúsculas"), label: z.string().trim().min(1).max(80), type: z.enum(INTAKE_TYPES), required: z.boolean().optional(), help: z.string().max(240).nullable().optional(),
  options: z.array(z.string().max(80)).max(50).optional(), placeholder: z.string().max(120).nullable().optional(), section: z.string().max(60).nullable().optional(),
  show_if: z.object({ field: z.string(), op: z.enum(["eq", "ne", "in", "truthy", "gt", "lt"]), value: z.unknown().optional() }).nullable().optional(), map_to: z.string().max(60).nullable().optional(),
});
export type IntakeField = z.infer<typeof intakeFieldSchema>;
export function validateIntakeForm(fields: unknown): IntakeField[] {
  const list = zp(z.array(intakeFieldSchema).max(60), fields);
  const keys = new Set<string>(); for (const f of list) { if (keys.has(f.key)) throw badRequest(`Campo repetido en el formulario: ${f.key}`); keys.add(f.key); if (f.map_to && !f.map_to.startsWith("custom.") && !MAPPABLE.has(f.map_to)) throw badRequest(`«${f.label}» no se puede volcar en ${f.map_to}`); if (["select", "multiselect"].includes(f.type) && !(f.options ?? []).length) throw badRequest(`«${f.label}» necesita opciones`); }
  return list;
}
function visible(f: IntakeField, vals: Row): boolean {
  if (!f.show_if) return true;
  const v = vals[f.show_if.field]; const w = f.show_if.value;
  switch (f.show_if.op) { case "eq": return String(v ?? "") === String(w ?? ""); case "ne": return String(v ?? "") !== String(w ?? ""); case "in": return (Array.isArray(w) ? w : String(w ?? "").split(",")).map(String).includes(String(v ?? "")); case "truthy": return !!v && v !== "false"; case "gt": return Number(v) > Number(w); case "lt": return Number(v) < Number(w); default: return true; }
}
/** Valida la solicitud contra el formulario del tipo y devuelve los valores a volcar en el contrato. */
export function applyIntake(ctx: Ctx, t: Row, input: Row): { fields: Row; custom: Row; intake: Row } {
  const form = (t.intake_form as IntakeField[]) ?? [];
  const intake: Row = { ...((input.intake as Row) ?? {}) };
  if (!form.length) return { fields: {}, custom: {}, intake };
  const vals: Row = { ...input, ...intake };
  const missing: string[] = []; const bad: string[] = []; const fields: Row = {}; const custom: Row = {};
  for (const f of form) {
    if (!visible(f, vals)) { delete intake[f.key]; continue; }
    let v = intake[f.key];
    if (isEmpty(v) && f.map_to && !f.map_to.startsWith("custom.")) v = input[f.map_to];
    if (isEmpty(v)) { if (f.required) missing.push(f.label); continue; }
    if (["number", "money"].includes(f.type)) { const n = Number(v); if (Number.isNaN(n)) { bad.push(`${f.label}: debe ser un número`); continue; } v = n; }
    if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) { bad.push(`${f.label}: fecha no válida`); continue; }
    if (f.type === "select" && !(f.options ?? []).includes(String(v))) { bad.push(`${f.label}: opción no válida`); continue; }
    if (f.type === "multiselect") { const arr = Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean); if (arr.some((x) => !(f.options ?? []).includes(x))) { bad.push(`${f.label}: opción no válida`); continue; } v = arr; }
    if (f.type === "boolean") v = v === true || v === "true" || v === 1 || v === "1" || v === "sí";
    if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) { bad.push(`${f.label}: email no válido`); continue; }
    intake[f.key] = v;
    if (f.map_to) { if (f.map_to.startsWith("custom.")) custom[f.map_to.slice(7)] = v; else fields[f.map_to] = v; }
  }
  if (missing.length || bad.length) throw badRequest([missing.length ? `Faltan datos de la solicitud: ${missing.join(", ")}` : "", ...bad].filter(Boolean).join(". "), { missing, invalid: bad });
  return { fields, custom, intake };
}

/* =============================================================== obligaciones e hitos por defecto, alertas */
export const defaultObligationSchema = z.object({ title: z.string().trim().min(1).max(200), type: z.string().max(30).optional(), obligor: z.enum(["us", "them"]).optional(), anchor: z.enum(["effective", "end", "signature"]).optional(), offset_days: z.number().int().min(-3650).max(3650).optional(), recurrence: z.enum(["none", "weekly", "monthly", "quarterly", "yearly"]).optional(), amount_pct: z.number().min(0).max(100).nullable().optional(), evidence_required: z.boolean().optional(), survives_termination: z.boolean().optional(), description: z.string().max(500).nullable().optional() });
export const defaultMilestoneSchema = z.object({ label: z.string().trim().min(1).max(120), type: z.string().max(30).optional(), anchor: z.enum(["effective", "end", "signature", "notice"]).optional(), offset_days: z.number().int().min(-3650).max(3650).optional(), alert_offsets: z.array(z.number().int().min(0).max(3650)).max(12).optional() });
export const alertConfigSchema = z.object({ notice: z.array(z.number().int().min(0).max(3650)).max(12).optional(), end: z.array(z.number().int().min(0).max(3650)).max(12).optional(), renewal: z.array(z.number().int().min(0).max(3650)).max(12).optional(), start: z.array(z.number().int().min(0).max(3650)).max(12).optional(), obligation: z.array(z.number().int().min(0).max(3650)).max(12).optional(), escalate_after_days: z.number().int().min(0).max(365).nullable().optional(), escalate_to: z.string().max(80).nullable().optional(), require_ack: z.boolean().optional() });
export type AlertConfig = z.infer<typeof alertConfigSchema>;
const addD = (iso: string, days: number) => addDays(iso.slice(0, 10) + "T00:00:00.000Z", days).slice(0, 10);
function anchorDate(c: Row, a: string | undefined): string | null {
  switch (a ?? "effective") { case "end": return (c.end_date as string | null) ?? null; case "signature": return String(c.signed_at ?? now()).slice(0, 10); case "notice": return (c.notice_deadline as string | null) ?? null; default: return (c.effective_date as string | null) ?? today(); }
}
/** Al activar: crea las obligaciones e hitos por defecto del tipo (si no existen ya). */
export function applyTypeDefaults(ctx: Ctx, cid: string) {
  const c = pj(ctx.db.get<Row>("SELECT * FROM contracts WHERE id=?", cid), clm.JC); const t = clm.getType(ctx, String(c.type_id));
  for (const o of (t.default_obligations as z.infer<typeof defaultObligationSchema>[]) ?? []) {
    if (ctx.db.get("SELECT id FROM obligations WHERE contract_id=? AND title=?", cid, o.title)) continue;
    const base = anchorDate(c, o.anchor);
    ctx.db.insert("obligations", { id: id(), workspace_id: ctx.ws, contract_id: cid, title: o.title, description: o.description ?? null, type: o.type ?? "other", obligor: o.obligor ?? "us", owner_id: c.owner_id, due_date: base ? addD(base, o.offset_days ?? 0) : null, recurrence: o.recurrence ?? "none", status: "pending", amount: o.amount_pct != null ? Math.round(Number(c.total_value || 0) * o.amount_pct) / 100 : null, currency: c.currency, penalty_rule: null, evidence_required: o.evidence_required ? 1 : 0, survives_termination: o.survives_termination ? 1 : 0, ai_extracted: 0, source_clause: `tipo:${t.code}`, created_at: now(), updated_at: now() });
  }
  for (const m of (t.default_milestones as z.infer<typeof defaultMilestoneSchema>[]) ?? []) {
    const base = anchorDate(c, m.anchor); if (!base) continue;
    const date = addD(base, m.offset_days ?? 0);
    if (ctx.db.get("SELECT id FROM milestones WHERE contract_id=? AND label=? AND date=?", cid, m.label, date)) continue;
    ctx.db.insert("milestones", { id: id(), workspace_id: ctx.ws, contract_id: cid, type: m.type ?? "custom", label: m.label, date, computed: 0, owner_id: c.owner_id, alert_offsets: m.alert_offsets ?? [30, 7, 1], alerted: [], status: date < today() ? "passed" : "upcoming", created_at: now() });
  }
}
export function alertConfig(ctx: Ctx, typeId: string): AlertConfig { try { return (clm.getType(ctx, typeId).alert_config as AlertConfig) ?? {}; } catch { return {}; } }
/** Acuse de recibo de una alerta de hito: detiene el escalado. */
export function ackMilestone(ctx: Ctx, mid: string): Row {
  const m = ctx.db.get<Row>("SELECT * FROM milestones WHERE id=? AND workspace_id=?", mid, ctx.ws); if (!m) throw notFound("Hito");
  clm.getContract(ctx, String(m.contract_id));
  ctx.db.update("milestones", mid, { acknowledged_at: now(), acknowledged_by: ctx.user.id });
  clm.tlog(ctx, String(m.contract_id), "milestone", `Alerta recibida: ${m.label}`, null, { milestone_id: mid });
  return pj(ctx.db.get<Row>("SELECT * FROM milestones WHERE id=?", mid), ["alert_offsets", "alerted"]);
}
/** Escala las alertas de hitos sin acuse pasado el plazo del tipo. */
export function escalateUnacknowledged(ctx: Ctx): number {
  let n = 0;
  for (const m of ctx.db.all<Row>("SELECT m.*, c.type_id, c.owner_id AS c_owner, c.legal_owner_id, c.number, c.title FROM milestones m JOIN contracts c ON c.id=m.contract_id WHERE m.workspace_id=? AND m.first_alerted_at IS NOT NULL AND m.acknowledged_at IS NULL AND m.escalated_at IS NULL AND m.status IN ('upcoming','alerted') AND c.deleted_at IS NULL", ctx.ws)) {
    const cfg = alertConfig(ctx, String(m.type_id));
    if (cfg.escalate_after_days == null) continue;
    if (addD(String(m.first_alerted_at), cfg.escalate_after_days) > today()) continue;
    const to = resolveTarget(ctx, cfg.escalate_to ?? "manager", { owner_id: m.c_owner, legal_owner_id: m.legal_owner_id });
    ctx.db.update("milestones", String(m.id), { escalated_at: now() });
    if (to) notify(ctx.db, ctx.ws, to, { type: "contract", title: `Escalado · alerta sin respuesta: ${m.label} (${m.number})`, body: String(m.title), link: `/contratos/${m.contract_id}?tab=milestones` });
    clm.tlog(ctx, String(m.contract_id), "warning", `Alerta sin acuse escalada: ${m.label}`, to ? `A ${clm.userNameOf(ctx, to)}` : null, {}, "system");
    n++;
  }
  return n;
}
/** Avisos de obligaciones con los desfases del tipo (por defecto 7 días antes). */
export function obligationAlerts(ctx: Ctx): number {
  let n = 0; const td = today();
  for (const o of ctx.db.all<Row>("SELECT o.*, c.number, c.type_id FROM obligations o JOIN contracts c ON c.id=o.contract_id WHERE o.workspace_id=? AND o.status IN ('pending','in_progress') AND o.due_date IS NOT NULL AND o.due_date >= ?", ctx.ws, td).map((r) => pj(r, ["alerted"]))) {
    const offsets = alertConfig(ctx, String(o.type_id)).obligation ?? [7];
    const alerted = (o.alerted as number[]) ?? [];
    const daysLeft = Math.round((Date.parse(String(o.due_date) + "T00:00:00Z") - Date.parse(td + "T00:00:00Z")) / 864e5);
    const due = offsets.filter((x) => !alerted.includes(x) && daysLeft <= x);
    if (!due.length) continue;
    ctx.db.update("obligations", String(o.id), { alerted: [...alerted, ...due], reminded_at: now() });
    notify(ctx.db, ctx.ws, o.owner_id as string, { type: "contract", title: `Obligación próxima: ${o.title}`, body: `${o.number} · vence el ${o.due_date} (${daysLeft} días)`, link: `/contratos/${o.contract_id}?tab=obligations` });
    n++;
  }
  return n;
}

/** Valida la configuración por tipo que llega en el alta/edición de un tipo de contrato. */
export function normalizeTypeConfig<T extends Record<string, unknown>>(b: T): T {
  const out: Record<string, unknown> = { ...b };
  if (b.intake_form !== undefined) out.intake_form = validateIntakeForm(b.intake_form);
  if (b.number_format) validateNumberFormat(String(b.number_format));
  if (b.number_format === "") out.number_format = null;
  if (b.default_obligations !== undefined) out.default_obligations = zp(z.array(defaultObligationSchema).max(40), b.default_obligations);
  if (b.default_milestones !== undefined) out.default_milestones = zp(z.array(defaultMilestoneSchema).max(40), b.default_milestones);
  if (b.alert_config !== undefined) out.alert_config = zp(alertConfigSchema, b.alert_config);
  return out as T;
}

/* =============================================================== exportar / importar */
type Export = { format: "crm-clm-config"; version: 1; exported_at: string; types: Row[]; clauses: Row[]; templates: Row[]; playbooks: Row[]; lifecycles: Row[]; approval_rules: Row[]; custom_fields: Row[] };
const TYPE_COLS = ["code", "name", "family", "direction", "description", "min_signature_level", "retention_years", "retention_basis", "number_prefix", "requires_dpa", "requires_kyc", "sla_hours", "self_service", "approval_rules", "color", "position", "active", "intake_form", "number_format", "default_obligations", "default_milestones", "alert_config"];
const JSON_TYPE = ["approval_rules", "intake_form", "default_obligations", "default_milestones", "alert_config"];
export function exportConfig(ctx: Ctx): Export {
  const types = ctx.db.all<Row>("SELECT * FROM contract_types WHERE workspace_id=? ORDER BY position, code", ctx.ws).map((t) => pj(t, JSON_TYPE));
  const codeOf = (tid: unknown) => types.find((t) => t.id === tid)?.code ?? null;
  const tplName = (tid: unknown) => (tid ? ctx.db.get<Row>("SELECT name, kind FROM clm_templates WHERE id=?", tid) : null);
  const pbName = (pid: unknown) => (pid ? ctx.db.get<Row>("SELECT name FROM playbooks WHERE id=?", pid)?.name ?? null : null);
  const email = (uid: unknown) => (uid ? ctx.db.get<Row>("SELECT email FROM users WHERE id=?", uid)?.email ?? null : null);
  return {
    format: "crm-clm-config", version: 1, exported_at: now(),
    types: types.map((t) => ({ ...Object.fromEntries(TYPE_COLS.map((k) => [k, t[k]])), default_template: tplName(t.default_template_id) ? { name: tplName(t.default_template_id)!.name, kind: tplName(t.default_template_id)!.kind } : null, default_playbook: pbName(t.default_playbook_id) })),
    clauses: ctx.db.all<Row>("SELECT code, title, category, variant_type, position, direction, body, risk_level, status, usage_guide, negotiation_notes, approver_role, language FROM clauses WHERE workspace_id=? ORDER BY code", ctx.ws),
    templates: ctx.db.all<Row>("SELECT name, type_id, language, body, kind, status, description FROM clm_templates WHERE workspace_id=? ORDER BY kind, name", ctx.ws).map((t) => { const { type_id, ...rest } = t; return { ...rest, type_code: codeOf(type_id) }; }),
    playbooks: ctx.db.all<Row>("SELECT name, type_id, direction, rules, active FROM playbooks WHERE workspace_id=? ORDER BY name", ctx.ws).map((p) => { const x = pj(p, ["rules"]); const { type_id, ...rest } = x; return { ...rest, type_code: codeOf(type_id) }; }),
    lifecycles: ctx.db.all<Row>("SELECT type_id, states, transitions FROM clm_lifecycles WHERE workspace_id=?", ctx.ws).map((l) => { const x = pj(l, ["states", "transitions"]); return { type_code: x.type_id === "*" ? "*" : codeOf(x.type_id), states: x.states, transitions: x.transitions }; }),
    approval_rules: listRules(ctx).map((r) => ({ name: r.name, priority: r.priority, active: !!r.active, type_codes: (r.type_ids as string[]).map(codeOf).filter(Boolean), conditions: r.conditions, reason: r.reason, stop: !!r.stop, steps: (r.steps as z.infer<typeof stepSchema>[]).map((s) => ({ ...s, approver: { ...s.approver, user_id: undefined, user_email: email(s.approver.user_id), users: undefined, user_emails: (s.approver.users ?? []).map(email).filter(Boolean) } })) })),
    custom_fields: ctx.db.all<Row>("SELECT key, label, type, options, required, default_value, settings, section, contract_type_id FROM custom_fields WHERE workspace_id=? AND object='contract' ORDER BY position", ctx.ws).map((f) => { const x = pj(f, ["options", "settings"]); const { contract_type_id, ...rest } = x; return { ...rest, type_code: codeOf(contract_type_id) }; }),
  };
}
export const importSchema = z.object({ data: z.object({ format: z.literal("crm-clm-config"), version: z.number() }).passthrough(), mode: z.enum(["merge", "replace"]).default("merge") });
/** Importa una configuración exportada (fusionando por código/nombre o sustituyendo reglas y ciclos). */
export function importConfig(ctx: Ctx, input: unknown): { created: Record<string, number>; updated: Record<string, number>; warnings: string[] } {
  const { data, mode } = zp(importSchema, input);
  const d = data as unknown as Export;
  const created: Record<string, number> = {}; const updated: Record<string, number> = {}; const warnings: string[] = [];
  const inc = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  ctx.db.transaction(() => {
    const typeId = (code: unknown) => (code ? ctx.db.get<Row>("SELECT id FROM contract_types WHERE workspace_id=? AND code=?", ctx.ws, code)?.id as string | undefined : undefined) ?? null;
    for (const c of d.clauses ?? []) { const ex = ctx.db.get<Row>("SELECT id FROM clauses WHERE workspace_id=? AND code=?", ctx.ws, c.code); if (ex) { ctx.db.update("clauses", String(ex.id), { ...c, updated_at: now() }); inc(updated, "clauses"); } else { ctx.db.insert("clauses", { id: id(), workspace_id: ctx.ws, ...c, version: 1, created_at: now(), updated_at: now() }); inc(created, "clauses"); } }
    for (const t of d.types ?? []) {
      const row: Row = Object.fromEntries(TYPE_COLS.filter((k) => k in t).map((k) => [k, t[k]]));
      const ex = ctx.db.get<Row>("SELECT id FROM contract_types WHERE workspace_id=? AND code=?", ctx.ws, t.code);
      if (ex) { ctx.db.update("contract_types", String(ex.id), row); inc(updated, "types"); } else { ctx.db.insert("contract_types", { id: id(), workspace_id: ctx.ws, ...row, created_at: now() }); inc(created, "types"); }
    }
    for (const t of d.templates ?? []) { const { type_code, ...rest } = t; const ex = ctx.db.get<Row>("SELECT id FROM clm_templates WHERE workspace_id=? AND name=? AND kind=?", ctx.ws, t.name, t.kind ?? "contract"); const row = { ...rest, type_id: typeId(type_code) }; if (ex) { ctx.db.update("clm_templates", String(ex.id), { ...row, updated_at: now() }); inc(updated, "templates"); } else { ctx.db.insert("clm_templates", { id: id(), workspace_id: ctx.ws, ...row, version: 1, created_at: now(), updated_at: now() }); inc(created, "templates"); } }
    for (const p of d.playbooks ?? []) { const { type_code, ...rest } = p; const ex = ctx.db.get<Row>("SELECT id FROM playbooks WHERE workspace_id=? AND name=?", ctx.ws, p.name); const row = { ...rest, type_id: typeId(type_code), active: p.active ? 1 : 0 }; if (ex) { ctx.db.update("playbooks", String(ex.id), { ...row, updated_at: now() }); inc(updated, "playbooks"); } else { ctx.db.insert("playbooks", { id: id(), workspace_id: ctx.ws, ...row, created_at: now(), updated_at: now() }); inc(created, "playbooks"); } }
    // referencias de los tipos a plantilla y playbook por nombre
    for (const t of d.types ?? []) {
      const tid = typeId(t.code); if (!tid) continue;
      const tpl = t.default_template as Row | null; const pb = t.default_playbook as string | null;
      ctx.db.update("contract_types", tid, { default_template_id: tpl ? (ctx.db.get<Row>("SELECT id FROM clm_templates WHERE workspace_id=? AND name=? AND kind=?", ctx.ws, tpl.name, tpl.kind)?.id ?? null) : null, default_playbook_id: pb ? (ctx.db.get<Row>("SELECT id FROM playbooks WHERE workspace_id=? AND name=?", ctx.ws, pb)?.id ?? null) : null });
    }
    if (mode === "replace") ctx.db.run("DELETE FROM clm_lifecycles WHERE workspace_id=?", ctx.ws);
    for (const l of d.lifecycles ?? []) {
      const tid = l.type_code === "*" ? "*" : typeId(l.type_code); if (!tid) { warnings.push(`Ciclo de vida para un tipo inexistente: ${l.type_code}`); continue; }
      const had = ctx.db.get("SELECT id FROM clm_lifecycles WHERE workspace_id=? AND type_id=?", ctx.ws, tid);
      saveLifecycle(ctx, tid, { states: l.states, transitions: l.transitions }); inc(had ? updated : created, "lifecycles");
    }
    if (d.approval_rules) {
      if (mode === "replace") ctx.db.run("DELETE FROM clm_approval_rules WHERE workspace_id=?", ctx.ws);
      saveSettings(ctx, { matrix_seeded: true });
      const userByEmail = (e: unknown) => (e ? ctx.db.get<Row>("SELECT id FROM users WHERE workspace_id=? AND lower(email)=lower(?)", ctx.ws, e)?.id as string | undefined : undefined);
      for (const r of d.approval_rules) {
        const steps = (r.steps as Row[]).map((s) => { const a = s.approver as Row; const uid = userByEmail(a.user_email); const users = ((a.user_emails as string[]) ?? []).map(userByEmail).filter(Boolean) as string[]; if (a.user_email && !uid) warnings.push(`Regla «${r.name}»: no existe el usuario ${a.user_email}; el paso pasa a administración`); return { ...s, approver: a.kind === "user" && !uid ? { kind: "role", role: "admin" } : { kind: a.kind, role: a.role, mode: a.mode, user_id: uid, users: users.length ? users : undefined } }; });
        const body = { name: r.name, priority: r.priority, active: r.active, type_ids: ((r.type_codes as string[]) ?? []).map(typeId).filter(Boolean), conditions: r.conditions, reason: r.reason, stop: r.stop, steps };
        const parsed = zp(ruleSchema, body);
        const ex = ctx.db.get<Row>("SELECT id FROM clm_approval_rules WHERE workspace_id=? AND name=?", ctx.ws, r.name);
        if (ex) { ctx.db.update("clm_approval_rules", String(ex.id), { ...parsed, active: parsed.active === false ? 0 : 1, stop: parsed.stop ? 1 : 0, updated_at: now() }); inc(updated, "approval_rules"); } else { insertRule(ctx, parsed); inc(created, "approval_rules"); }
      }
    }
    for (const f of d.custom_fields ?? []) {
      const { type_code, ...rest } = f; const tid = type_code ? typeId(type_code) : null;
      const ex = ctx.db.get<Row>("SELECT id FROM custom_fields WHERE workspace_id=? AND object='contract' AND key=?", ctx.ws, f.key);
      const row = { ...rest, contract_type_id: tid };
      if (ex) { ctx.db.update("custom_fields", String(ex.id), row); inc(updated, "custom_fields"); } else { ctx.db.insert("custom_fields", { id: id(), workspace_id: ctx.ws, object: "contract", position: 999, ...row }); inc(created, "custom_fields"); }
    }
  });
  audit(ctx, "clm_config", null, "import", { mode, created, updated, warnings: warnings.length });
  return { created, updated, warnings };
}
