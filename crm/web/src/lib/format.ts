export const fmtMoney = (n: number | null | undefined, currency = "EUR") => new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(n) || 0);
export const fmtMoney2 = (n: number | null | undefined, currency = "EUR") => new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(Number(n) || 0);
export const fmtNum = (n: number | null | undefined) => new Intl.NumberFormat("es-ES").format(Number(n) || 0);
export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" }) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-ES", opts).format(d);
}
export const fmtDateTime = (iso: string | null | undefined) => fmtDate(iso, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
export const fmtTime = (iso: string | null | undefined) => fmtDate(iso, { hour: "2-digit", minute: "2-digit" });
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const m = Math.round(abs / 60000), h = Math.round(abs / 3600000), d = Math.round(abs / 86400000);
  let s: string;
  if (m < 1) s = "ahora"; else if (m < 60) s = `${m} min`; else if (h < 24) s = `${h} h`; else if (d < 30) s = `${d} d`; else if (d < 365) { const m2 = Math.max(1, Math.round(d / 30)); s = m2 === 1 ? "1 mes" : `${m2} meses`; } else { const y = Math.max(1, Math.round(d / 365)); s = y === 1 ? "1 año" : `${y} años`; }
  if (s === "ahora") return s;
  return future ? `en ${s}` : `hace ${s}`;
}
export const isOverdue = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < Date.now();
export const isToday = (iso: string | null | undefined) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
export const todayISO = () => new Date().toISOString().slice(0, 10);
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (s: string) => (s ? new Date(s).toISOString() : null);
export const initials = (name: string | null | undefined) => (name ?? "?").split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
export const fullName = (c: { first_name?: string; last_name?: string } | null | undefined) => `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim();
export const pct = (n: number | null | undefined) => `${Math.round(Number(n) || 0)}%`;

export const LIFECYCLE: Record<string, string> = { subscriber: "Suscriptor", lead: "Lead", mql: "MQL", sql: "SQL", opportunity: "Oportunidad", customer: "Cliente", evangelist: "Evangelista", lost: "Perdido" };
export const LEAD_STATUS: Record<string, string> = { new: "Nuevo", contacted: "Contactado", qualified: "Cualificado", unqualified: "No cualificado", nurturing: "En nutrición" };
export const SOURCES: Record<string, string> = { web: "Web", referral: "Referido", event: "Evento", outbound: "Outbound", ads: "Anuncios", import: "Importación", api: "API", other: "Otro" };
export const COMPANY_TYPES: Record<string, string> = { prospect: "Prospecto", customer: "Cliente", partner: "Partner", competitor: "Competidor", supplier: "Proveedor" };
export const TASK_TYPES: Record<string, string> = { call: "Llamada", email: "Email", meeting: "Reunión", followup: "Seguimiento", todo: "Tarea" };
export const PRIORITY: Record<string, string> = { low: "Baja", normal: "Normal", high: "Alta", urgent: "Urgente" };
export const ACTIVITY_TYPES: Record<string, string> = { email: "Email", call: "Llamada", meeting: "Reunión", note: "Nota", task: "Tarea", sms: "SMS", whatsapp: "WhatsApp", chat: "Chat", system: "Sistema" };
export const LOSS_REASONS: Record<string, string> = { price: "Precio", competitor: "Competidor", no_budget: "Sin presupuesto", no_response: "Sin respuesta", timing: "Timing", no_need: "Sin necesidad", other: "Otro" };
export const TICKET_STATUS: Record<string, string> = { new: "Nuevo", open: "Abierto", pending: "Pendiente del cliente", resolved: "Resuelto", closed: "Cerrado" };
export const DEAL_STATUS: Record<string, string> = { open: "Abierto", won: "Ganado", lost: "Perdido" };
export const QUOTE_STATUS: Record<string, string> = { draft: "Borrador", sent: "Enviado", viewed: "Visto", accepted: "Aceptado", rejected: "Rechazado", expired: "Caducado" };
export const ROLE_LABEL: Record<string, string> = { decision_maker: "Decisor", influencer: "Influenciador", user: "Usuario", other: "Otro" };
export const OPS_LABEL: Record<string, string> = { eq: "es", neq: "no es", contains: "contiene", not_contains: "no contiene", starts: "empieza por", gt: "mayor que", gte: "mayor o igual", lt: "menor que", lte: "menor o igual", empty: "está vacío", not_empty: "no está vacío", in: "es uno de", not_in: "no es ninguno de", last_days: "en los últimos N días", next_days: "en los próximos N días", before: "antes de", after: "después de", today: "es hoy", is_true: "es sí", is_false: "es no" };
export const FIELD_LABEL: Record<string, string> = { first_name: "Nombre", last_name: "Apellidos", email: "Email", phone: "Teléfono", job_title: "Cargo", company_id: "Empresa (id)", lifecycle_stage: "Etapa ciclo de vida", lead_status: "Estado del lead", source: "Origen", owner_id: "Propietario", score: "Puntuación", language: "Idioma", city: "Ciudad", country: "País", consent_marketing: "Consentimiento marketing", do_not_contact: "No contactar", tags: "Etiquetas", last_activity_at: "Última actividad", last_contacted_at: "Último contacto", created_at: "Fecha de creación", updated_at: "Última modificación", birthday: "Cumpleaños", name: "Nombre", domain: "Dominio", sector: "Sector", size: "Empleados", revenue: "Facturación", type: "Tipo", status: "Estado", parent_id: "Empresa matriz", pipeline_id: "Pipeline", stage_id: "Etapa", amount: "Importe", currency: "Moneda", probability: "Probabilidad", expected_close_date: "Cierre previsto", closed_at: "Fecha de cierre", loss_reason: "Motivo de pérdida", stage_entered_at: "Entrada en etapa", next_activity_at: "Próxima actividad", subject: "Asunto", priority: "Prioridad", category: "Categoría", assignee_id: "Asignado", channel: "Canal", contact_id: "Contacto (id)", sla_due_at: "Vencimiento SLA", resolved_at: "Resuelto el", title: "Título", due_at: "Vencimiento", completed_at: "Completada el" };
