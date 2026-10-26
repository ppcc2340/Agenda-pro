/**
 * Listas de valores totalmente personalizables (CRM y CLM).
 *
 * Cada lista tiene un conjunto fijo de «comportamientos» (roles) que entiende la lógica del CRM: «Resuelto» cierra
 * el SLA, «Ganado» suma a ventas, «Cliente» cuenta como conversión… Las ETIQUETAS son del usuario: puede renombrar,
 * recolorear, ordenar, ocultar, añadir y borrar cualquiera (también las originales). Cada etiqueta declara su
 * comportamiento.
 *
 * El registro guarda el comportamiento en su campo (p. ej. `lead_status = 'qualified'`) y, si la etiqueta no es la
 * principal de ese comportamiento, su id en `custom._lbl_<campo>`. Así la lógica, los informes y las
 * automatizaciones siguen funcionando aunque se cambie todo el vocabulario.
 */
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest, conflict } from "../lib/errors.js";
import { id, now } from "../lib/util.js";
import { audit } from "./audit.js";

export interface Role { key: string; label: string; color: string; logic?: string }
export interface PicklistDef { key: string; module: "CRM" | "CLM"; object: string; field: string; label: string; roles: Role[]; /** se pueden añadir etiquetas propias (el registro tiene `custom`) */ extensible: boolean; table?: string }
export interface PicklistOption { id: string; label: string; color: string; role: string; position: number; hidden?: boolean }

const C = { blue: "#579bfc", purple: "#a25ddc", green: "#00c875", red: "#e2445c", orange: "#fdab3d", dark: "#323338", teal: "#66ccff", grey: "#c4c4c4", indigo: "#5559df", violet: "#784bd1", lime: "#9cd326" };
const R = (key: string, label: string, color: string, logic?: string): Role => ({ key, label, color, logic });

export const PICKLISTS: PicklistDef[] = [
  { key: "contact.lifecycle_stage", module: "CRM", object: "contact", field: "lifecycle_stage", label: "Contactos · Etapa del ciclo de vida", extensible: true, roles: [
    R("subscriber", "Suscriptor", C.grey), R("lead", "Lead", C.blue, "Etapa inicial de los contactos nuevos y de los formularios"), R("mql", "MQL", C.indigo, "Se asigna sola al superar el umbral de puntuación MQL"), R("sql", "SQL", C.violet, "Se asigna sola al superar el umbral SQL"),
    R("opportunity", "Oportunidad", C.purple, "Se asigna al crear un negocio para el contacto"), R("customer", "Cliente", C.green, "Se asigna al ganar un negocio; cuenta como conversión en informes y no se anonimiza por retención"), R("evangelist", "Evangelista", C.lime, "Cuenta como conversión"), R("lost", "Perdido", C.red)] },
  { key: "contact.lead_status", module: "CRM", object: "contact", field: "lead_status", label: "Contactos · Estado del lead", extensible: true, roles: [
    R("new", "Nuevo", C.blue, "Cuenta para el SLA de primer contacto"), R("contacted", "Contactado", C.orange), R("qualified", "Cualificado", C.green, "Se asigna al convertir en negocio; dispara recetas de conversión"), R("unqualified", "No cualificado", C.red, "Pide motivo de descalificación"), R("nurturing", "En nutrición", C.purple)] },
  { key: "company.type", module: "CRM", object: "company", field: "type", label: "Empresas · Tipo", extensible: true, roles: [R("prospect", "Prospecto", C.blue), R("customer", "Cliente", C.green), R("partner", "Partner", C.purple), R("competitor", "Competidor", C.red), R("supplier", "Proveedor", C.orange)] },
  { key: "deal.status", module: "CRM", object: "deal", field: "status", label: "Negocios · Estado", extensible: true, roles: [R("open", "Abierto", C.blue, "Cuenta en pipeline y previsión"), R("won", "Ganado", C.green, "Suma a ventas y cuotas; convierte los contactos en clientes"), R("lost", "Perdido", C.red, "Pide motivo de pérdida; cuenta en informes de pérdida")] },
  { key: "ticket.status", module: "CRM", object: "ticket", field: "status", label: "Tickets · Estado", extensible: true, roles: [R("new", "Nuevo", C.blue, "Pasa a Abierto con la primera respuesta"), R("open", "Abierto", C.orange, "El SLA corre"), R("pending", "Pendiente del cliente", C.purple), R("resolved", "Resuelto", C.green, "Fecha de resolución, cierra el SLA y envía la encuesta de satisfacción"), R("closed", "Cerrado", C.dark, "Cierra el SLA")] },
  { key: "ticket.priority", module: "CRM", object: "ticket", field: "priority", label: "Tickets · Prioridad", extensible: true, roles: [R("low", "Baja", C.teal, "SLA de baja"), R("normal", "Normal", C.blue, "SLA normal"), R("high", "Alta", C.orange, "SLA alto"), R("urgent", "Urgente", C.red, "SLA urgente")] },
  { key: "task.type", module: "CRM", object: "task", field: "type", label: "Tareas · Tipo", extensible: true, roles: [R("call", "Llamada", C.blue, "Al completarla se registra una llamada"), R("email", "Email", C.purple, "Se registra un email"), R("meeting", "Reunión", C.green, "Se registra una reunión"), R("followup", "Seguimiento", C.orange), R("todo", "Tarea", C.grey)] },
  { key: "task.priority", module: "CRM", object: "task", field: "priority", label: "Tareas · Prioridad", extensible: true, roles: [R("low", "Baja", C.teal), R("normal", "Normal", C.blue), R("high", "Alta", C.red)] },
  { key: "contract.status", module: "CLM", object: "contract", field: "status", label: "Contratos · Estado", extensible: false, roles: [
    R("DRAFT", "Borrador", C.grey), R("INTERNAL_REVIEW", "Revisión interna", C.blue), R("NEGOTIATION", "Negociación", C.purple), R("PENDING_APPROVAL", "Pendiente de aprobación", C.orange), R("APPROVED", "Aprobado", C.lime), R("OUT_FOR_SIGNATURE", "En firma", C.indigo), R("PARTIALLY_SIGNED", "Firmado parcialmente", C.violet),
    R("ACTIVE", "Activo", C.green, "Genera obligaciones, hitos y pagos"), R("EXPIRED", "Vencido", "#808080"), R("TERMINATED", "Terminado", C.red), R("RENEWED", "Renovado", C.teal), R("CANCELLED", "Cancelado", C.dark), R("REJECTED", "Rechazado", "#bb3354"), R("ON_HOLD", "En pausa", "#cab641"), R("ARCHIVED", "Archivado", "#7f5347")] },
  { key: "contract.risk_level", module: "CLM", object: "contract", field: "risk_level", label: "Contratos · Riesgo", extensible: true, roles: [R("low", "Bajo", C.green), R("medium", "Medio", C.orange), R("high", "Alto", C.red, "Añade a legal a las aprobaciones"), R("critical", "Crítico", C.dark, "Añade dirección a las aprobaciones")] },
  { key: "contract.urgency", module: "CLM", object: "contract", field: "urgency", label: "Contratos · Urgencia", extensible: true, roles: [R("normal", "Normal", C.blue), R("high", "Alta", C.orange, "Reduce el SLA de legal"), R("critical", "Crítica", C.red, "SLA de legal mínimo")] },
  { key: "contract.renewal_type", module: "CLM", object: "contract", field: "renewal_type", label: "Contratos · Renovación", extensible: true, roles: [R("none", "Sin renovación", C.grey), R("auto", "Automática", C.orange, "Calcula el límite de preaviso y avisa"), R("by_agreement", "Por acuerdo", C.blue, "Crea el hito de decisión de renovación")] },
  { key: "contract.paper_origin", module: "CLM", object: "contract", field: "paper_origin", label: "Contratos · Papel", extensible: true, roles: [R("ours", "Nuestra plantilla", C.green), R("theirs", "Papel de la contraparte", C.orange, "Activa la revisión contra el playbook")] },
  { key: "contract.payment_model", module: "CLM", object: "contract", field: "payment_model", label: "Contratos · Modelo de pago", extensible: true, roles: [R("one_off", "Pago único", C.grey), R("recurring", "Recurrente", C.blue, "Genera el calendario de pagos"), R("milestone", "Por hitos", C.purple), R("usage", "Por uso", C.orange)] },
  { key: "contract.confidentiality", module: "CLM", object: "contract", field: "confidentiality", label: "Contratos · Confidencialidad", extensible: true, roles: [R("normal", "Normal", C.blue), R("confidential", "Confidencial", C.orange), R("restricted", "Restringido", C.red, "Solo propietario, legal y administración")] },
  { key: "obligation.type", module: "CLM", object: "obligation", field: "type", label: "Obligaciones · Tipo", extensible: false, table: "obligations", roles: ["payment:Pago", "delivery:Entrega", "report:Informe", "sla:SLA", "insurance:Seguro", "audit:Auditoría", "confidentiality:Confidencialidad", "notice:Notificación", "renewal:Renovación", "compliance:Cumplimiento", "training:Formación", "price_review:Revisión de precios", "minimum_commit:Compromiso mínimo", "exclusivity:Exclusividad", "return:Devolución", "other:Otra"].map((x, i) => { const [k, l] = x.split(":"); return R(k!, l!, Object.values(C)[i % 11]!); }) },
  { key: "milestone.type", module: "CLM", object: "milestone", field: "type", label: "Hitos · Tipo", extensible: false, table: "milestones", roles: ["start:Inicio", "end:Fin de vigencia", "notice_deadline:Límite de preaviso", "renewal:Renovación", "price_review:Revisión de precios", "delivery:Entrega", "audit:Auditoría", "warranty_end:Fin de garantía", "trial_end:Fin de prueba", "exclusivity_end:Fin de exclusividad", "insurance_expiry:Vencimiento del seguro", "custom:Personalizado"].map((x, i) => { const [k, l] = x.split(":"); return R(k!, l!, Object.values(C)[i % 11]!); }) },
];
export const picklistDef = (key: string) => PICKLISTS.find((p) => p.key === key);
export const picklistFor = (object: string, field: string) => PICKLISTS.find((p) => p.object === object && p.field === field);

const TABLE: Record<string, string> = { contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", task: "tasks", contract: "contracts" };
const tableOf = (d: PicklistDef) => d.table ?? TABLE[d.object]!;
const hasDeleted = (t: string) => !["tasks", "tickets", "obligations", "milestones"].includes(t);

/** Opciones actuales de una lista (si no se ha tocado: una por comportamiento, con las etiquetas de fábrica). */
export function picklistOptions(ctx: Ctx, key: string): PicklistOption[] {
  const d = picklistDef(key); if (!d) throw badRequest("Lista no encontrada");
  const rows = ctx.db.all<Row>("SELECT * FROM picklist_options WHERE workspace_id=? AND picklist=? ORDER BY position", ctx.ws, key);
  if (rows.length) return rows.map((r) => ({ id: String(r.id), label: String(r.label), color: String(r.color), role: String(r.role), position: Number(r.position), hidden: !!r.hidden }));
  // migración: etiquetas añadidas antes en la configuración del tablero
  const cfg = parseJson(ctx.db.get<Row>("SELECT config FROM board_configs WHERE workspace_id=? AND object=?", ctx.ws, d.object), ["config"])?.config as Row | undefined;
  const ov = ((cfg?.labels as Record<string, Record<string, { label?: string; color?: string; hidden?: boolean }>> | undefined) ?? {})[d.field] ?? {};
  const extras = ((cfg?.extra_labels as Record<string, { id: string; label: string; color: string; base: string }[]> | undefined) ?? {})[d.field] ?? [];
  const order = ((cfg?.label_order as Record<string, string[]> | undefined) ?? {})[d.field];
  const base: PicklistOption[] = [...d.roles.map((r) => ({ id: r.key, label: ov[r.key]?.label ?? r.label, color: ov[r.key]?.color ?? r.color, role: r.key, position: 0, hidden: !!ov[r.key]?.hidden })), ...extras.filter((x) => d.roles.some((r) => r.key === x.base)).map((x) => ({ id: x.id, label: x.label, color: x.color, role: x.base, position: 0 }))];
  if (order) base.sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
  return base.map((o, i) => ({ ...o, position: i }));
}

/** Etiqueta que se muestra para un valor: la indicada en _lbl si sigue existiendo y es de ese comportamiento; si no, la principal del comportamiento. */
export function resolveOption(opts: PicklistOption[], role: unknown, lbl: unknown): PicklistOption | null {
  if (role === null || role === undefined || role === "") return null;
  const r = String(role);
  if (lbl) { const o = opts.find((x) => x.id === lbl && x.role === r); if (o) return o; }
  return opts.find((x) => x.id === r) ?? opts.find((x) => x.role === r) ?? null;
}

/** Recuento de registros por opción (en el orden de resolución anterior). */
export function picklistUsage(ctx: Ctx, key: string, opts = picklistOptions(ctx, key)): Record<string, number> {
  const d = picklistDef(key)!; const t = tableOf(d);
  const lblExpr = ["obligation", "milestone"].includes(d.object) ? "NULL" : `json_extract(COALESCE(custom,'{}'),'$._lbl_${d.field}')`;
  const rows = ctx.db.all<{ v: string | null; l: string | null; n: number }>(`SELECT ${d.field} v, ${lblExpr} l, COUNT(*) n FROM ${t} WHERE workspace_id=?${hasDeleted(t) ? " AND deleted_at IS NULL" : ""} GROUP BY 1, 2`, ctx.ws);
  const out: Record<string, number> = {}; let orphan = 0;
  for (const r of rows) { const o = resolveOption(opts, r.v, r.l); if (o) out[o.id] = (out[o.id] ?? 0) + r.n; else if (r.v) orphan += r.n; }
  if (orphan) out.__orphan = orphan;
  return out;
}

export interface SaveInput { options: { id?: string; label: string; color: string; role: string; hidden?: boolean }[]; /** opción eliminada → opción que la sustituye en los registros */ reassign?: Record<string, string> }

/**
 * Guarda la lista completa. Las opciones eliminadas que estén en uso necesitan sustituta en `reassign`: los
 * registros se mueven a ella (cambiando su comportamiento si la sustituta tiene otro, con su lógica y eventos).
 */
export function savePicklist(ctx: Ctx, key: string, input: SaveInput, applyPatch: (ctx: Ctx, object: string, rid: string, patch: Row) => unknown) {
  const d = picklistDef(key); if (!d) throw badRequest("Lista no encontrada");
  const before = picklistOptions(ctx, key);
  const usage = picklistUsage(ctx, key, before);
  const roles = new Set(d.roles.map((r) => r.key));
  const seen = new Set<string>(); const seenLabel = new Set<string>();
  const next: PicklistOption[] = input.options.map((o, i) => {
    const label = o.label.trim(); if (!label) throw badRequest("Hay una etiqueta sin nombre");
    if (!roles.has(o.role)) throw badRequest(`Comportamiento no válido: ${o.role}`);
    const lk = label.toLowerCase(); if (seenLabel.has(lk)) throw badRequest(`Etiqueta repetida: ${label}`); seenLabel.add(lk);
    let oid = o.id && before.some((b) => b.id === o.id) ? o.id : roles.has(o.id ?? "") && !seen.has(o.id!) ? o.id! : `x_${id().replace(/-/g, "").slice(0, 10)}`;
    if (seen.has(oid)) oid = `x_${id().replace(/-/g, "").slice(0, 10)}`;
    seen.add(oid);
    const prev = before.find((b) => b.id === oid);
    if (prev && prev.role !== o.role && (usage[oid] ?? 0) > 0) throw conflict(`«${prev.label}» está en uso: para cambiar su comportamiento crea una etiqueta nueva y mueve los registros`);
    if (!d.extensible && !roles.has(oid)) throw badRequest(`En «${d.label}» solo se pueden renombrar, recolorear, ordenar u ocultar las etiquetas`);
    return { id: oid, label, color: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : "#c4c4c4", role: o.role, position: i, hidden: !!o.hidden };
  });
  if (!next.length) throw badRequest("La lista necesita al menos una etiqueta");
  const removed = before.filter((b) => !next.some((n) => n.id === b.id));
  const moves: { from: PicklistOption; to: PicklistOption }[] = [];
  for (const r of removed) {
    if (!(usage[r.id] ?? 0)) continue;
    const to = next.find((n) => n.id === input.reassign?.[r.id]);
    if (!to) throw conflict(`«${r.label}» tiene ${usage[r.id]} registro(s): elige a qué etiqueta moverlos`, { option: r.id, count: usage[r.id] });
    moves.push({ from: r, to });
  }
  if (!d.extensible && removed.some((r) => d.roles.some((x) => x.key === r.id))) throw badRequest("En esta lista las etiquetas no se borran: ocúltalas");
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM picklist_options WHERE workspace_id=? AND picklist=?", ctx.ws, key);
    for (const o of next) ctx.db.insert("picklist_options", { workspace_id: ctx.ws, picklist: key, id: o.id, label: o.label, color: o.color, role: o.role, position: o.position, hidden: o.hidden ? 1 : 0, updated_at: now() });
  });
  // mover registros de las etiquetas eliminadas (con su lógica: cambiar a «Ganado», «Resuelto»… dispara lo que corresponda)
  let moved = 0;
  if (moves.length) {
    const t = tableOf(d);
    const rows = ctx.db.all<Row>(`SELECT id, ${d.field} v, ${["obligation", "milestone"].includes(d.object) ? "NULL" : `json_extract(COALESCE(custom,'{}'),'$._lbl_${d.field}')`} l FROM ${t} WHERE workspace_id=?${hasDeleted(t) ? " AND deleted_at IS NULL" : ""}`, ctx.ws);
    for (const r of rows) {
      const cur = resolveOption(before, r.v, r.l); const mv = moves.find((m) => m.from.id === cur?.id); if (!mv) continue;
      const patch: Row = mv.to.role !== r.v ? { [d.field]: mv.to.role } : {};
      if (!["obligation", "milestone"].includes(d.object)) patch.custom = { [`_lbl_${d.field}`]: mv.to.id === mv.to.role ? null : mv.to.id };
      if (["obligation", "milestone"].includes(d.object)) ctx.db.run(`UPDATE ${t} SET ${d.field}=? WHERE id=?`, mv.to.role, r.id);
      else applyPatch(ctx, d.object, String(r.id), patch);
      moved++;
    }
  }
  audit(ctx, "picklist", key, "update", { options: next.map((o) => `${o.label}≈${o.role}`), removed: removed.map((r) => r.label), moved });
  return { ...picklistInfo(ctx, d), moved };
}

/** Datos completos de una lista para la interfaz: comportamientos, opciones, uso y lógica que queda sin etiqueta. */
export function picklistInfo(ctx: Ctx, d: PicklistDef) {
  const options = picklistOptions(ctx, d.key);
  const usage = picklistUsage(ctx, d.key, options);
  const uncovered = d.roles.filter((r) => !options.some((o) => o.role === r.key && !o.hidden)).map((r) => ({ role: r.key, label: r.label, logic: r.logic ?? null }));
  return { key: d.key, module: d.module, object: d.object, field: d.field, label: d.label, extensible: d.extensible, roles: d.roles, options, usage, uncovered };
}
export const allPicklists = (ctx: Ctx) => PICKLISTS.map((d) => picklistInfo(ctx, d));

/** Texto visible de un valor de lista para un registro (celdas, exportaciones, plantillas). */
export function picklistText(ctx: Ctx, object: string, field: string, value: unknown, custom: Row | null | undefined): string | null {
  const d = picklistFor(object, field); if (!d) return null;
  const o = resolveOption(picklistOptions(ctx, d.key), value, (custom ?? {})[`_lbl_${field}`]);
  return o?.label ?? (value == null ? null : String(value));
}
