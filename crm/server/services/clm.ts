/**
 * CLM — gestión del ciclo de vida del contrato.
 * Tipos, numeración, plantillas, biblioteca de cláusulas, extracción basada en reglas, playbook,
 * riesgo, máquina de estados, aprobaciones, firma electrónica simple (SES), obligaciones, hitos,
 * pagos, enmiendas, renovaciones, terminación, retención e informes.
 */
import { z } from "zod";
import { applyDefaults, checkRequired } from "./columns.js";
import type { Ctx } from "../context.js";
import { parseJson as parseJsonRaw, type Row } from "../db.js";
const parseJson = (row: Row | undefined, cols: string[]): Row => (parseJsonRaw(row ?? {}, cols) ?? {}) as Row;
import { id, now, addDays, sha256, token, renderTemplate } from "../lib/util.js";
import { badRequest, notFound, conflict, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord, ownerScope, isAdmin } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { notify } from "./notifications.js";
import { nextCounter } from "./counters.js";
import { listRecords, listQuery, type ListQuery, validateCustom } from "./records.js";
import { sendMail } from "./email.js";
import { createTask } from "./tasks.js";

export const JC = ["tags", "custom", "effective_values", "intake", "risk_factors"];
export const STATUSES = ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ACTIVE", "EXPIRED", "TERMINATED", "RENEWED", "CANCELLED", "REJECTED", "ON_HOLD", "ARCHIVED"] as const;
export const PRE_SIGNATURE = ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ON_HOLD"];
export const FAMILIES = ["sales", "purchases", "confidentiality", "hr", "real_estate", "financial", "ip_data", "public", "internal"] as const;
export const CATEGORIES: Record<string, string> = {
  A01: "Partes", A02: "Considerandos", A03: "Definiciones", A04: "Objeto y alcance", A05: "Prelación de documentos", A06: "Anexos", A07: "Totalidad del acuerdo", A08: "Modificaciones por escrito", A09: "Nulidad parcial", A10: "No renuncia", A11: "Notificaciones", A12: "Idioma prevalente", A13: "Firma electrónica",
  B01: "Entrada en vigor", B02: "Duración", B03: "Renovación", B04: "Terminación por conveniencia", B05: "Terminación por incumplimiento", B06: "Terminación por insolvencia", B07: "Terminación por cambio de control", B08: "Efectos de la terminación", B09: "Obligaciones supervivientes", B10: "Transición / reversibilidad",
  C01: "Precio", C02: "Plazos de pago", C03: "Facturación", C04: "Intereses de demora", C05: "Revisión de precios", C06: "Impuestos", C07: "Descuentos", C08: "Gastos", C09: "Penalizaciones", C10: "Créditos de servicio", C11: "Garantía de pago", C12: "Compensación", C13: "Compromiso mínimo", C14: "Auditoría de precios",
  D01: "Obligaciones del proveedor", D02: "Obligaciones del cliente", D03: "Niveles de servicio (SLA)", D04: "Entregables y aceptación", D05: "Cambios de alcance", D06: "Personal clave", D07: "Subcontratación", D08: "Cumplimiento de leyes", D09: "Reporting", D10: "Formación",
  E01: "Limitación de responsabilidad", E02: "Exclusiones de la limitación", E03: "Indemnización", E04: "Garantías", E05: "Exclusión de garantías", E06: "Seguros", E07: "Fuerza mayor", E08: "Garantía de producto",
  F01: "Confidencialidad", F02: "Protección de datos (DPA)", F03: "Transferencias internacionales", F04: "Seguridad de la información", F05: "Derecho de auditoría", F06: "Continuidad de negocio", F07: "Ubicación de datos", F08: "Uso de IA / entrenamiento",
  G01: "PI preexistente", G02: "Titularidad de resultados", G03: "Licencia concedida", G04: "Cesión de derechos", G05: "Derechos morales e imagen", G06: "Software de terceros", G07: "Marcas y publicidad",
  H01: "Exclusividad", H02: "No competencia", H03: "No captación", H04: "Cesión del contrato", H05: "Cambio de control", H06: "Independencia de las partes", H07: "Relación laboral excluida", H08: "Conflicto de intereses", H09: "Anticorrupción", H10: "Sanciones y exportación", H11: "ESG",
  I01: "Ley aplicable", I02: "Jurisdicción", I03: "Arbitraje", I04: "Mediación", I05: "Costas",
  J01: "Incoterm", J02: "Cláusulas LAU", J03: "Cláusulas laborales", J04: "Cláusulas DORA", J05: "Cláusulas LCSP",
};
export const OBLIGATION_TYPES = ["payment", "delivery", "report", "sla", "insurance", "audit", "confidentiality", "notice", "renewal", "compliance", "training", "price_review", "minimum_commit", "exclusivity", "return", "other"] as const;
export const MILESTONE_TYPES = ["start", "end", "notice_deadline", "renewal", "price_review", "delivery", "audit", "warranty_end", "trial_end", "exclusivity_end", "insurance_expiry", "custom"] as const;
const EEA = new Set(["ES", "PT", "FR", "DE", "IT", "NL", "BE", "LU", "AT", "IE", "FI", "SE", "DK", "PL", "CZ", "SK", "HU", "RO", "BG", "HR", "SI", "EE", "LV", "LT", "GR", "CY", "MT", "IS", "LI", "NO"]);

/* ---------- helpers ---------- */
const d10 = (d: Date | string) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
export function addMonths(dateIso: string, months: number): string {
  const d = new Date(dateIso.slice(0, 10) + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
const addD = (dateIso: string, days: number) => addDays(dateIso.slice(0, 10) + "T00:00:00.000Z", days).slice(0, 10);
const today = () => now().slice(0, 10);
const userName = (ctx: Ctx, uid: string | null | undefined) => (uid ? (ctx.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", uid)?.name ?? "") : "");
function usersWithRole(ctx: Ctx, roleKey: string): Row[] { return ctx.db.all<Row>("SELECT u.* FROM users u JOIN roles r ON r.id=u.role_id WHERE u.workspace_id=? AND u.active=1 AND r.key=? ORDER BY u.name", ctx.ws, roleKey); }
function roleKeyOf(ctx: Ctx, uid: string | null | undefined): string { return uid ? (ctx.db.get<{ key: string }>("SELECT r.key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?", uid)?.key ?? "") : ""; }
function managerOf(ctx: Ctx, uid: string | null | undefined): string | null {
  if (!uid) return null;
  const u = ctx.db.get<Row>("SELECT team_id FROM users WHERE id=?", uid);
  const t = u?.team_id ? ctx.db.get<Row>("SELECT manager_id FROM teams WHERE id=?", u.team_id) : null;
  const m = (t?.manager_id as string | null) ?? null;
  if (m && m !== uid) return m;
  const anyManager = usersWithRole(ctx, "manager").find((x) => x.id !== uid);
  return (anyManager?.id as string) ?? (usersWithRole(ctx, "admin").find((x) => x.id !== uid)?.id as string) ?? null;
}
export function tlog(ctx: Ctx, contractId: string, type: string, title: string, body?: string | null, meta: Record<string, unknown> = {}, actorType: "user" | "system" | "external" | "agent" = "user", actorName?: string) {
  ctx.db.insert("contract_timeline", { id: id(), workspace_id: ctx.ws, contract_id: contractId, type, title, body: body ?? null, actor_id: actorType === "user" ? ctx.user.id : null, actor_name: actorName ?? (actorType === "user" ? ctx.user.name : actorType === "system" ? "Sistema" : "Externo"), actor_type: actorType, meta, at: now() });
  ctx.db.run("UPDATE contracts SET last_activity_at=? WHERE id=?", now(), contractId);
}
export function getType(ctx: Ctx, typeId: string): Row {
  const t = ctx.db.get<Row>("SELECT * FROM contract_types WHERE id=? AND workspace_id=?", typeId, ctx.ws);
  if (!t) throw notFound("Tipo de contrato");
  return parseJson(t as Row, ["approval_rules"]);
}
export function getContract(ctx: Ctx, cid: string): Row {
  const c = ctx.db.get<Row>(`SELECT c.*, t.name AS type_name, t.code AS type_code, t.direction, t.color AS type_color, t.min_signature_level, co.name AS counterparty_name, co.country AS counterparty_country, co.tax_id AS counterparty_tax_id,
    u.name AS owner_name, lu.name AS legal_owner_name, d.name AS deal_name, p.number AS parent_number, p.title AS parent_title
    FROM contracts c JOIN contract_types t ON t.id=c.type_id LEFT JOIN companies co ON co.id=c.counterparty_company_id LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN users lu ON lu.id=c.legal_owner_id LEFT JOIN deals d ON d.id=c.deal_id LEFT JOIN contracts p ON p.id=c.parent_id
    WHERE c.id=? AND c.workspace_id=? AND c.deleted_at IS NULL`, cid, ctx.ws);
  if (!c) throw notFound("Contrato");
  if (!canSeeRecord(ctx, c.owner_id as string | null) && c.legal_owner_id !== ctx.user.id) throw forbidden("Este contrato es de otro equipo");
  return parseJson(c as Row, JC);
}
function nextNumber(ctx: Ctx, prefix: string): string {
  const year = new Date().getFullYear();
  const seq = nextCounter(ctx.db, ctx.ws, `contract:${prefix}:${year}`);
  return `${prefix}-${year}-${String(seq).padStart(5, "0")}`;
}
export function computeDates(c: Row): Partial<Row> {
  const out: Partial<Row> = {};
  const eff = c.effective_date as string | null;
  let end = c.end_date as string | null;
  if (eff && c.term_type === "fixed" && c.term_months && !end) end = addD(addMonths(eff, Number(c.term_months)), -1);
  out.end_date = end;
  out.notice_deadline = end && c.notice_period_days ? addD(end, -Number(c.notice_period_days)) : null;
  out.next_renewal_date = end && c.renewal_type !== "none" ? addD(end, 1) : null;
  return out;
}

/* ---------- schemas ---------- */
const nullStr = z.string().trim().nullable().optional();
export const contractSchema = z.object({
  title: z.string().trim().min(1, "El título es obligatorio").max(300),
  type_id: z.string(),
  counterparty_company_id: z.string().nullable().optional(),
  counterparty_name: z.string().trim().optional(), // crea la empresa si no existe
  deal_id: z.string().nullable().optional(),
  quote_id: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
  legal_owner_id: z.string().nullable().optional(),
  department: nullStr,
  paper_origin: z.enum(["ours", "theirs"]).optional(),
  language: z.string().length(2).optional(),
  governing_law: z.string().min(2).max(5).optional(),
  jurisdiction: nullStr,
  arbitration: z.boolean().optional(),
  effective_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  term_type: z.enum(["fixed", "indefinite", "milestone"]).optional(),
  term_months: z.number().int().min(0).nullable().optional(),
  renewal_type: z.enum(["none", "auto", "by_agreement"]).optional(),
  renewal_period_months: z.number().int().min(1).nullable().optional(),
  notice_period_days: z.number().int().min(0).nullable().optional(),
  max_renewals: z.number().int().nullable().optional(),
  total_value: z.number().min(0).optional(),
  annual_value: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  value_basis: z.enum(["fixed", "estimated", "consumption"]).optional(),
  payment_model: z.enum(["one_off", "recurring", "milestone", "usage"]).optional(),
  payment_terms_days: z.number().int().min(0).optional(),
  confidentiality: z.enum(["normal", "confidential", "restricted"]).optional(),
  contains_personal_data: z.boolean().optional(),
  data_role: z.enum(["controller", "processor", "joint"]).nullable().optional(),
  international_transfer: z.boolean().optional(),
  dora_in_scope: z.boolean().optional(),
  public_sector: z.boolean().optional(),
  counterparty_outside_eea: z.boolean().optional(),
  urgency: z.enum(["normal", "high", "critical"]).optional(),
  description: nullStr,
  tags: z.array(z.string()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  intake: z.record(z.string(), z.unknown()).optional(),
  template_id: z.string().nullable().optional(),
  body: z.string().optional(), // texto propio (papel de la contraparte)
  file_name: nullStr,
  justification: nullStr,
});
export type ContractInput = z.infer<typeof contractSchema>;
export const typeSchema = z.object({
  code: z.string().trim().min(2).max(12).regex(/^[A-Z0-9_]+$/, "Código en mayúsculas"), name: z.string().trim().min(1), family: z.enum(FAMILIES).optional(), direction: z.enum(["income", "expense", "neutral"]).optional(), description: nullStr,
  min_signature_level: z.enum(["SES", "AdES", "QES"]).optional(), retention_years: z.number().int().min(1).max(30).optional(), retention_basis: z.enum(["termination", "signature"]).optional(), number_prefix: z.string().trim().min(1).max(8).optional(),
  requires_dpa: z.boolean().optional(), requires_kyc: z.boolean().optional(), sla_hours: z.number().int().min(1).optional(), self_service: z.boolean().optional(), approval_rules: z.array(z.any()).optional(), default_template_id: z.string().nullable().optional(), default_playbook_id: z.string().nullable().optional(), color: z.string().optional(), position: z.number().int().optional(), active: z.boolean().optional(),
});
export const clauseSchema = z.object({ code: z.string().trim().min(2).max(24), title: z.string().trim().min(1), category: z.string().regex(/^[A-J]\d\d$/), variant_type: z.enum(["standard", "alternative", "fallback", "prohibited"]).optional(), position: z.enum(["preferred", "acceptable", "last_resort", "never"]).optional(), direction: z.enum(["income", "expense", "both"]).optional(), body: z.string().min(1), risk_level: z.enum(["low", "medium", "high"]).optional(), status: z.enum(["draft", "approved", "retired"]).optional(), usage_guide: nullStr, negotiation_notes: nullStr, approver_role: nullStr, language: z.string().optional() });
export const templateSchema = z.object({ name: z.string().trim().min(1), type_id: z.string().nullable().optional(), language: z.string().optional(), body: z.string().min(1), kind: z.enum(["contract", "amendment", "renewal", "termination", "letter"]).optional(), status: z.enum(["draft", "approved", "retired"]).optional(), description: nullStr });
export const playbookSchema = z.object({ name: z.string().trim().min(1), type_id: z.string().nullable().optional(), direction: z.enum(["income", "expense", "both"]).optional(), rules: z.array(z.object({ category: z.string(), must_exist: z.boolean().optional(), must_exist_if_personal_data: z.boolean().optional(), preferred: z.string().nullable().optional(), acceptable: z.array(z.string()).optional(), fallback: z.string().nullable().optional(), thresholds: z.record(z.string(), z.any()).optional(), prohibited_patterns: z.array(z.string()).optional(), if_present: z.enum(["ok", "minor", "major", "prohibited"]).optional(), minor_approver: z.string().optional(), major_approver: z.string().optional(), guidance: z.string().optional() })).optional(), active: z.boolean().optional() });
export const obligationSchema = z.object({ title: z.string().trim().min(1), description: nullStr, type: z.enum(OBLIGATION_TYPES).optional(), obligor: z.enum(["us", "them"]).optional(), owner_id: z.string().nullable().optional(), due_date: z.string().nullable().optional(), recurrence: z.enum(["none", "weekly", "monthly", "quarterly", "yearly"]).optional(), amount: z.number().nullable().optional(), currency: z.string().optional(), penalty_rule: nullStr, evidence_required: z.boolean().optional(), survives_termination: z.boolean().optional(), survival_until: z.string().nullable().optional(), source_clause: nullStr, status: z.enum(["pending", "in_progress", "fulfilled", "breached", "waived", "na"]).optional() });
export const milestoneSchema = z.object({ type: z.enum(MILESTONE_TYPES).optional(), label: z.string().trim().min(1), date: z.string(), owner_id: z.string().nullable().optional(), alert_offsets: z.array(z.number().int().min(0)).optional() });

/* ======================= plantillas ======================= */
const fmtMoney = (n: unknown, cur = "EUR") => new Intl.NumberFormat("es-ES", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(Number(n) || 0);
const fmtDateLong = (s: unknown) => (s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const getPath = (o: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

/** Contexto de variables para una plantilla: contract.*, counterparty.*, entity.*, deal.*, quote.*, intake.*, user.*, today */
export function templateContext(ctx: Ctx, c: Row): Record<string, unknown> {
  const cp: Row = c.counterparty_company_id ? parseJson((ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.counterparty_company_id) ?? {}) as Row, ["tags", "custom"]) : {};
  const deal = c.deal_id ? ctx.db.get<Row>("SELECT * FROM deals WHERE id=?", c.deal_id) : null;
  const products = c.deal_id ? ctx.db.all<Row>("SELECT * FROM deal_products WHERE deal_id=?", c.deal_id) : [];
  const quote = c.quote_id ? ctx.db.get<Row>("SELECT * FROM quotes WHERE id=?", c.quote_id) : null;
  const signerUs = ctx.db.get<Row>("SELECT u.name FROM signature_authority s JOIN users u ON u.id=s.user_id WHERE s.workspace_id=? AND s.active=1 ORDER BY s.max_value DESC LIMIT 1", ctx.ws);
  const cpContact = c.counterparty_company_id ? ctx.db.get<Row>("SELECT first_name, last_name, job_title, email FROM contacts WHERE company_id=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1", c.counterparty_company_id) : null;
  return {
    contract: { ...c, total_value_fmt: fmtMoney(c.total_value, String(c.currency || "EUR")), annual_value_fmt: fmtMoney(c.annual_value, String(c.currency || "EUR")), effective_date_fmt: c.effective_date ? fmtDateLong(c.effective_date) : "la fecha de su firma", end_date_fmt: c.end_date ? fmtDateLong(c.end_date) : "su vencimiento", term_months: c.term_months ?? 12, notice_period_days: c.notice_period_days ?? "", renewal_period_months: c.renewal_period_months ?? c.term_months ?? 12 },
    counterparty: { name: cp.name ?? "[contraparte]", tax_id: cp.tax_id ?? "[CIF]", address: cp.address ?? "", city: cp.city ?? "", country: cp.country ?? "ES", domain: cp.domain ?? "", representative: cpContact ? `${cpContact.first_name} ${cpContact.last_name}`.trim() : "[representante]", representative_title: cpContact?.job_title ?? "", email: cpContact?.email ?? "" },
    entity: { name: ctx.settings.company_name, tax_id: "[CIF de la sociedad]", address: "[domicilio social]", city: "Madrid", country: "ES", representative: signerUs?.name ?? ctx.user.name },
    deal: deal ? { ...deal, products, amount_fmt: fmtMoney(deal.amount, String(deal.currency || "EUR")) } : { products: [] },
    quote: quote ?? {},
    intake: (c.intake as Record<string, unknown>) ?? {},
    user: { name: ctx.user.name, email: ctx.user.email },
    today: fmtDateLong(now()), today_iso: today(), now: now(), year: new Date().getFullYear(),
  };
}
function evalExpr(expr: string, ctx: Record<string, unknown>): boolean {
  const e = expr.trim();
  const m = e.match(/^(!?)\s*([a-zA-Z_][\w.]*)\s*(?:(==|!=|>=|<=|>|<)\s*(.+))?$/);
  if (!m) return false;
  const [, neg, path, op, rawVal] = m;
  const v = getPath(ctx, path!);
  if (!op) { const t = !!v && v !== "0" && v !== 0 && v !== "false"; return neg ? !t : t; }
  let cmp: unknown = rawVal!.trim();
  if (/^['"].*['"]$/.test(String(cmp))) cmp = String(cmp).slice(1, -1); else if (!Number.isNaN(Number(cmp))) cmp = Number(cmp); else if (cmp === "true") cmp = true; else if (cmp === "false") cmp = false;
  const a = typeof cmp === "number" ? Number(v) : typeof cmp === "boolean" ? (!!v && v !== 0) : String(v ?? "");
  switch (op) { case "==": return a === cmp; case "!=": return a !== cmp; case ">": return Number(a) > Number(cmp); case "<": return Number(a) < Number(cmp); case ">=": return Number(a) >= Number(cmp); case "<=": return Number(a) <= Number(cmp); }
  return false;
}
function applyFilter(v: unknown, filter: string | undefined, cur: string): string {
  if (!filter) return v === null || v === undefined ? "" : String(v);
  const [name, argRaw] = filter.split(":").map((s) => s.trim()) as [string, string?];
  const arg = argRaw ? argRaw.replace(/^['"]|['"]$/g, "") : undefined;
  switch (name) {
    case "money": return fmtMoney(v, arg ?? cur);
    case "date": return fmtDateLong(v);
    case "upper": return String(v ?? "").toUpperCase();
    case "default": return v === null || v === undefined || v === "" ? (arg ?? "") : String(v);
    case "words": return numberToWords(Number(v) || 0);
    default: return String(v ?? "");
  }
}
export function numberToWords(n: number): string {
  const u = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
  const t = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  const h = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
  const sub1000 = (x: number): string => { if (x < 30) return u[x]!; if (x < 100) return t[Math.floor(x / 10)] + (x % 10 ? " y " + u[x % 10] : ""); if (x === 100) return "cien"; return h[Math.floor(x / 100)] + (x % 100 ? " " + sub1000(x % 100) : ""); };
  n = Math.floor(Math.abs(n));
  if (n < 1000) return sub1000(n);
  if (n < 1e6) { const k = Math.floor(n / 1000); return (k === 1 ? "mil" : sub1000(k) + " mil") + (n % 1000 ? " " + sub1000(n % 1000) : ""); }
  const m = Math.floor(n / 1e6); return (m === 1 ? "un millón" : sub1000(m) + " millones") + (n % 1e6 ? " " + numberToWords(n % 1e6) : "");
}
export interface RenderResult { text: string; clauses: { code: string; category: string; clause_id: string | null; heading: string; text: string }[]; unresolved: string[] }
/** Motor de plantillas: {{var|filter}}, {% if %}/{% else %}/{% endif %}, {% for x in list %}, {% clause "CODE" [if expr] %}, {% signature_block party="us" %} */
export function renderContractTemplate(ctx: Ctx, body: string, vars: Record<string, unknown>): RenderResult {
  const clauses: RenderResult["clauses"] = []; const unresolved: string[] = [];
  const cur = String((vars.contract as Row)?.currency ?? "EUR");
  const findClause = (code: string) => ctx.db.get<Row>("SELECT * FROM clauses WHERE workspace_id=? AND code=? AND status='approved'", ctx.ws, code);
  const render = (src: string, scope: Record<string, unknown>): string => {
    // if / else / endif (innermost first)
    let out = src;
    const ifRe = /\{%\s*if\s+([^%]+?)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/;
    for (let i = 0; i < 50 && ifRe.test(out); i++) out = out.replace(ifRe, (_m, cond, a, b) => (evalExpr(cond, scope) ? a : b ?? ""));
    const forRe = /\{%\s*for\s+(\w+)\s+in\s+([\w.]+)\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/;
    for (let i = 0; i < 20 && forRe.test(out); i++) out = out.replace(forRe, (_m, item, listPath, block) => { const list = getPath(scope, listPath); if (!Array.isArray(list)) return ""; return list.map((it, idx) => render(block, { ...scope, [item]: it, loop: { index: idx + 1 } })).join(""); });
    out = out.replace(/\{%\s*clause\s+"([^"]+)"(?:\s+if\s+([^%]+?))?\s*%\}/g, (_m, code, cond) => {
      if (cond && !evalExpr(cond, scope)) return "";
      const cl = findClause(code);
      if (!cl) { unresolved.push(`cláusula ${code}`); return `[CLÁUSULA ${code} NO ENCONTRADA]`; }
      const text = render(String(cl.body), scope);
      clauses.push({ code, category: String(cl.category), clause_id: String(cl.id), heading: String(cl.title), text });
      ctx.db.run("UPDATE clauses SET usage_count=usage_count+1 WHERE id=?", cl.id);
      return `${cl.title}\n${text}`;
    });
    out = out.replace(/\{%\s*signature_block\s+party="(us|them)"\s*%\}/g, (_m, party) => {
      const p = party === "us" ? (scope.entity as Row) : (scope.counterparty as Row);
      return `\n______________________________\nPor ${p.name}\n${p.representative ?? ""}${party === "them" && (p.representative_title) ? `, ${p.representative_title}` : ""}\nFecha: ____________\n`;
    });
    out = out.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]+?))?\s*\}\}/g, (_m, path, filter) => {
      const v = getPath(scope, path);
      if ((v === undefined || v === null || v === "") && !(filter && filter.startsWith("default"))) { unresolved.push(path); return `[${path}]`; }
      return applyFilter(v, filter, cur);
    });
    return out;
  };
  return { text: render(body, vars).replace(/\n{3,}/g, "\n\n").trim(), clauses, unresolved: Array.from(new Set(unresolved)) };
}

/* ======================= extracción (basada en reglas) y playbook ======================= */
export interface Finding { category: string; level: "ok" | "minor" | "major" | "prohibited" | "missing"; explanation: string; source_text?: string; params?: Record<string, unknown>; approver_role?: string; suggested?: string | null; suggested_clause_id?: string | null }
const NUM_WORDS: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20, treinta: 30, sesenta: 60, noventa: 90, cien: 100, ciento: 100 };
const num = (s: string | undefined) => { if (!s) return null; const n = Number(s.replace(/[^\d.,]/g, "").replace(",", ".")); if (!Number.isNaN(n) && s.match(/\d/)) return n; return NUM_WORDS[s.toLowerCase()] ?? null; };
const snippet = (text: string, idx: number, len = 180) => text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + len)).replace(/\s+/g, " ").trim();
const DETECT: { category: string; re: RegExp }[] = [
  { category: "A01", re: /\b(reunidos|de una parte|partes?\b.*\bcif|razón social)/i }, { category: "A03", re: /\bdefiniciones\b/i }, { category: "A04", re: /\b(objeto del (contrato|acuerdo)|alcance)\b/i },
  { category: "A11", re: /\bnotificaciones?\b/i }, { category: "A12", re: /\b(idioma|versión prevalente)\b/i }, { category: "A13", re: /\bfirma electrónica\b/i },
  { category: "B01", re: /\b(entrada en vigor|fecha efectiva|surtirá efectos)/i }, { category: "B02", re: /\bduración\b/i }, { category: "B03", re: /\b(renovar|renovación|prórroga|prorrogar)/i },
  { category: "B04", re: /\b(terminación|resolución) (anticipada|por conveniencia|sin causa|unilateral)/i }, { category: "B05", re: /\b(incumplimiento)\b/i }, { category: "B09", re: /\b(supervivencia|sobrevivir|subsistir)/i },
  { category: "C01", re: /\b(precio|contraprestación|honorarios|importe)\b/i }, { category: "C02", re: /\b(plazo de pago|pago de las facturas|se abonar|pagar[áa]n?)\b/i }, { category: "C03", re: /\bfactur/i }, { category: "C04", re: /\b(intereses de demora|mora)\b/i }, { category: "C05", re: /\b(revisión de precios|actualización de precios|ipc)\b/i }, { category: "C09", re: /\b(penalizaci|cláusula penal)/i },
  { category: "D03", re: /\b(nivel(es)? de servicio|sla|disponibilidad)\b/i }, { category: "D04", re: /\b(entregables?|aceptación)\b/i }, { category: "D07", re: /\bsubcontrat/i }, { category: "D08", re: /\b(cumplimiento (normativo|de (la )?legislación))/i },
  { category: "E01", re: /\b(limitaci[óo]n de (la )?responsabilidad|responsabilidad[^.]{0,60}(ilimitada|limitada|no exceder[áa]|total|m[áa]xima)|responder[áa] (por|hasta))/i }, { category: "E03", re: /\b(indemniz|mantendr[áa] indemne)/i }, { category: "E04", re: /\bgarant[íi]a/i }, { category: "E06", re: /\b(seguro|póliza)\b/i }, { category: "E07", re: /\bfuerza mayor\b/i },
  { category: "F01", re: /\bconfidencial/i }, { category: "F02", re: /\b(encargad[oa] del tratamiento|protección de datos|rgpd|art(ículo|\.)? 28)/i }, { category: "F03", re: /\b(transferencia(s)? internacional|cláusulas contractuales tipo)/i }, { category: "F04", re: /\b(seguridad de la información|iso 27001|incidente de seguridad)/i }, { category: "F05", re: /\b(derecho de auditoría|auditar)\b/i },
  { category: "G01", re: /\b(propiedad intelectual|derechos de propiedad)\b/i }, { category: "G02", re: /\b(desarrollos|resultados del (trabajo|servicio)|obra(s)? (creada|desarrollada))/i }, { category: "G03", re: /\blicencia\b/i },
  { category: "H01", re: /\bexclusiv/i }, { category: "H02", re: /\bno competencia\b/i }, { category: "H03", re: /\b(no captación|no solicitación|contratar (a )?empleados)/i }, { category: "H04", re: /\b(cesión del contrato|ceder (el|este) contrato)/i }, { category: "H05", re: /\bcambio de control\b/i }, { category: "H09", re: /\b(anticorrupción|soborno)\b/i },
  { category: "I01", re: /\b(ley aplicable|legislación aplicable|se regirá|se rige)\b/i }, { category: "I02", re: /\b(jurisdicción|juzgados y tribunales|tribunales de)\b/i }, { category: "I03", re: /\barbitraje\b/i },
];
/** Extrae categorías y parámetros clave del texto de una versión (sustituye a la extracción con IA del manual con reglas explicables). */
export function extractFromText(text: string): { categories: Record<string, { source_text: string; params: Record<string, unknown> }>; meta: Record<string, unknown> } {
  const t = text; const low = t.toLowerCase();
  const categories: Record<string, { source_text: string; params: Record<string, unknown> }> = {};
  for (const d of DETECT) { const m = t.match(d.re); if (m && m.index !== undefined) categories[d.category] = { source_text: snippet(t, m.index), params: {} }; }
  const meta: Record<string, unknown> = {};
  // plazo de pago
  const pay = t.match(/(?:plazo de pago|pagar[áa]n?|se abonar[áa]n?|vencimiento)[^.]{0,80}?(\d{1,3}|treinta|sesenta|noventa|quince)\s*d[ií]as/i);
  if (pay) { const days = num(pay[1]); meta.payment_terms_days = days; categories.C02 = { source_text: snippet(t, pay.index!), params: { days } }; }
  // responsabilidad
  const cat = categories.E01;
  if (cat) {
    const p: Record<string, unknown> = {};
    if (/responsabilidad[^.]{0,60}ilimitada|sin\s+(l[ií]mite|limitaci[óo]n)\s+(alguno\s+)?(de|en)\s+(su\s+)?responsabilidad/i.test(t)) p.cap_type = "unlimited";
    else { const pct = t.match(/(\d{2,3})\s*%\s*(?:del|de la|de los)\s*(?:valor|importe|precio|cuota)[^.]{0,40}(anual|total)?/i); const months = t.match(/(doce|seis|veinticuatro|\d{1,2})\s*\(?\d*\)?\s*meses\s+(anteriores|previos|inmediatamente)/i); if (pct) { p.cap_type = pct[2] === "total" ? "pct_total_value" : "pct_annual_value"; p.pct = Number(pct[1]); } else if (months) { p.cap_type = "months_fees"; p.months = num(months[1]); } else { const amt = t.match(/no exceder[áa][^.]{0,60}?([\d.,]+)\s*(?:€|euros)/i); if (amt) { p.cap_type = "amount"; p.amount = Number(String(amt[1]).replace(/\./g, "").replace(",", ".")); } else p.cap_type = "unknown"; } }
    p.indirect_excluded = /lucro cesante|daños indirectos/i.test(t) && !/incluid[oa]s?\s+(el\s+)?lucro cesante/i.test(t);
    cat.params = p; meta.liability = p;
  }
  // ley aplicable
  const law = t.match(/(?:ley|legislaci[óo]n|derecho)\s+(?:aplicable\s+)?(?:ser[áa]\s+)?(?:la\s+)?(espa[ñn]ola|de espa[ñn]a|portuguesa|francesa|alemana|italiana|inglesa|de inglaterra|del estado de [a-z ]+|de los estados unidos|de nueva york|de california|irlandesa|holandesa|belga|suiza)/i);
  if (law) { const map: Record<string, string> = { "española": "ES", "de españa": "ES", portuguesa: "PT", francesa: "FR", alemana: "DE", italiana: "IT", inglesa: "GB", "de inglaterra": "GB", "de los estados unidos": "US", "de nueva york": "US", "de california": "US", irlandesa: "IE", holandesa: "NL", belga: "BE", suiza: "CH" }; const key = law[1]!.toLowerCase().replace("ñ", "ñ"); const code = map[key] ?? (key.startsWith("del estado de") ? "US" : "XX"); meta.governing_law = code; categories.I01 = { source_text: snippet(t, law.index!), params: { law: code } }; }
  // preaviso / renovación
  const notice = t.match(/preaviso\s+(?:m[ií]nimo\s+)?(?:de\s+|por escrito de\s+)?(\d{1,3}|un|dos|tres|seis|treinta|sesenta|noventa)\s*(d[ií]as|meses|mes)\b/i);
  if (notice) { const n = num(notice[1]) ?? 0; const days = /mes/i.test(notice[2]!) ? n * 30 : n; meta.notice_period_days = days; categories.B03 = { source_text: snippet(t, notice.index!), params: { ...(categories.B03?.params ?? {}), notice_days: days } }; }
  if (/renovar[áa]\s+(autom[áa]tica|t[áa]cita)mente|renovaci[óo]n\s+(autom[áa]tica|t[áa]cita)|se prorrogar[áa]\s+autom[áa]ticamente|per[ií]odos sucesivos/i.test(t)) { meta.renewal_type = "auto"; categories.B03 = { source_text: categories.B03?.source_text ?? snippet(t, low.indexOf("renov")), params: { ...(categories.B03?.params ?? {}), renewal: "auto" } }; }
  const dur = t.match(/duraci[óo]n\s+(?:de|del|inicial de|del presente contrato ser[áa] de)?\s*(\d{1,3}|un|dos|tres|cinco|seis|doce|veinticuatro)\s*(?:\(\d+\)\s*)?(a[ñn]os?|meses)/i);
  if (dur) { const n = num(dur[1]) ?? 0; meta.term_months = /a[ñn]o/i.test(dur[2]!) ? n * 12 : n; categories.B02 = { source_text: snippet(t, dur.index!), params: { months: meta.term_months } }; }
  if (/datos personales|datos de car[áa]cter personal/i.test(t)) meta.contains_personal_data = true;
  if (categories.F02) meta.has_dpa = true;
  if (categories.H01) { const ex = t.match(/exclusiv[^.]{0,200}/i); categories.H01.params = { scope: ex ? ex[0].slice(0, 160) : "" }; meta.exclusivity = true; }
  if (categories.H03) meta.non_solicit = true;
  const conf = t.match(/confidencial[^.]{0,160}?(\d{1,2}|cinco|dos|tres|diez)\s*(?:\(\d+\)\s*)?a[ñn]os/i);
  if (conf && categories.F01) { categories.F01.params = { years: num(conf[1]) }; meta.confidentiality_years = num(conf[1]); }
  const val = t.match(/(?:precio|importe|contraprestaci[óo]n)[^.]{0,80}?([\d]{1,3}(?:[.\d]{3})*(?:,\d{2})?)\s*(?:€|euros)/i);
  if (val) meta.total_value = Number(val[1]!.replace(/\./g, "").replace(",", "."));
  return { categories, meta };
}
function playbookFor(ctx: Ctx, c: Row): Row | null {
  const t = getType(ctx, String(c.type_id));
  if (t.default_playbook_id) { const pb = ctx.db.get<Row>("SELECT * FROM playbooks WHERE id=? AND active=1", t.default_playbook_id); if (pb) return parseJson(pb as Row, ["rules"]); }
  const byType = ctx.db.get<Row>("SELECT * FROM playbooks WHERE workspace_id=? AND active=1 AND type_id=? ORDER BY created_at LIMIT 1", ctx.ws, c.type_id);
  if (byType) return parseJson(byType as Row, ["rules"]);
  const generic = ctx.db.get<Row>("SELECT * FROM playbooks WHERE workspace_id=? AND active=1 AND type_id IS NULL AND (direction='both' OR direction=?) ORDER BY created_at LIMIT 1", ctx.ws, t.direction);
  return generic ? parseJson(generic as Row, ["rules"]) : null;
}
/** Revisión contra playbook: devuelve hallazgos ordenados prohibited > missing > major > minor > ok. */
export function reviewAgainstPlaybook(ctx: Ctx, c: Row, extracted: ReturnType<typeof extractFromText>): { findings: Finding[]; playbook: Row | null } {
  const pb = playbookFor(ctx, c);
  const findings: Finding[] = [];
  const rules = (pb?.rules as Record<string, unknown>[] | undefined) ?? [];
  const clauseByCode = (code: string | null | undefined) => (code ? ctx.db.get<Row>("SELECT id, title, code FROM clauses WHERE workspace_id=? AND code=?", ctx.ws, code) : null);
  for (const r of rules) {
    const cat = String(r.category); const present = extracted.categories[cat]; const th = (r.thresholds as Record<string, number>) ?? {};
    const pref = clauseByCode(r.preferred as string | null);
    const base: Finding = { category: cat, level: "ok", explanation: "", source_text: present?.source_text, params: present?.params, suggested: pref?.code as string | undefined, suggested_clause_id: (pref?.id as string) ?? null };
    const mustExist = r.must_exist === true || (r.must_exist_if_personal_data && c.contains_personal_data);
    if (!present) { if (mustExist) findings.push({ ...base, level: "missing", explanation: `Falta la cláusula de ${CATEGORIES[cat] ?? cat}, obligatoria según el playbook.`, approver_role: String(r.major_approver ?? "legal") }); continue; }
    const p = present.params;
    if (r.if_present && r.if_present !== "ok") { findings.push({ ...base, level: r.if_present as Finding["level"], explanation: `El contrato incluye ${CATEGORIES[cat]?.toLowerCase() ?? cat}; nuestra política requiere aprobación para aceptarla.`, approver_role: String(r.if_present === "major" ? r.major_approver ?? "legal_director" : r.minor_approver ?? "legal") }); continue; }
    for (const pat of (r.prohibited_patterns as string[]) ?? []) { if (new RegExp(pat, "i").test(present.source_text) || (cat === "E01" && p.cap_type === "unlimited" && /ilimitad/i.test(pat))) { findings.push({ ...base, level: "prohibited", explanation: `Cláusula prohibida: coincide con «${pat}».`, approver_role: "ceo" }); break; } }
    if (findings.some((f) => f.category === cat && f.level === "prohibited")) continue;
    if (cat === "E01") {
      if (p.cap_type === "unlimited") { findings.push({ ...base, level: "prohibited", explanation: "Responsabilidad ilimitada: nunca aceptable. Proponer tope sobre el valor anual.", approver_role: "ceo" }); continue; }
      const pct = p.cap_type === "pct_annual_value" ? Number(p.pct) : p.cap_type === "months_fees" ? Math.round((Number(p.months) / 12) * 100) : p.cap_type === "pct_total_value" ? Number(p.pct) : null;
      const min = th.liability_cap_min_pct ?? 100, max = th.liability_cap_max_pct ?? 200;
      if (pct === null) findings.push({ ...base, level: "minor", explanation: "No se ha podido determinar el tope de responsabilidad; revisar manualmente.", approver_role: String(r.minor_approver ?? "legal") });
      else if (pct < min) findings.push({ ...base, level: "major", explanation: `Tope de responsabilidad del ${pct} % del valor anual, por debajo del mínimo (${min} %).`, approver_role: String(r.major_approver ?? "legal_director") });
      else if (pct > max) findings.push({ ...base, level: "major", explanation: `Tope del ${pct} % supera el máximo que aceptamos (${max} %).`, approver_role: String(r.major_approver ?? "legal_director") });
      else if (p.indirect_excluded === false) findings.push({ ...base, level: "minor", explanation: "No excluye daños indirectos ni lucro cesante.", approver_role: String(r.minor_approver ?? "legal") });
      else findings.push({ ...base, level: "ok", explanation: `Tope del ${pct} % del valor anual con exclusión de indirectos: dentro de política.` });
      continue;
    }
    if (cat === "C02" && p.days != null) {
      const days = Number(p.days); const legalMax = th.payment_days_legal_max ?? 60; const preferred = th.payment_days_preferred ?? 30; const max = th.payment_days_max ?? 60;
      if (days > legalMax) findings.push({ ...base, level: "prohibited", explanation: `Plazo de pago de ${days} días supera el máximo legal de ${legalMax} días (Ley 3/2004): cláusula nula.`, approver_role: "legal_director" });
      else if (days > max) findings.push({ ...base, level: "major", explanation: `Plazo de pago de ${days} días supera nuestro máximo (${max}).`, approver_role: String(r.major_approver ?? "cfo") });
      else if (days > preferred) findings.push({ ...base, level: "minor", explanation: `Plazo de pago de ${days} días; preferimos ${preferred}.`, approver_role: String(r.minor_approver ?? "legal") });
      else findings.push({ ...base, level: "ok", explanation: `Plazo de pago de ${days} días: correcto.` });
      continue;
    }
    if (cat === "I01" && p.law) {
      const law = String(p.law); const okVals = (r.preferred_values as string[] | undefined) ?? ["ES"]; const acc = (r.acceptable_values as string[] | undefined) ?? Array.from(EEA);
      if (okVals.includes(law)) findings.push({ ...base, level: "ok", explanation: `Ley aplicable ${law}: preferida.` });
      else if (acc.includes(law)) findings.push({ ...base, level: "minor", explanation: `Ley aplicable ${law}: aceptable con revisión.`, approver_role: String(r.minor_approver ?? "legal") });
      else findings.push({ ...base, level: "major", explanation: `Ley aplicable ${law}: fuera del EEE, requiere aprobación del director legal.`, approver_role: String(r.major_approver ?? "legal_director") });
      continue;
    }
    if (cat === "B03") {
      const nd = p.notice_days as number | undefined; const min = th.notice_period_days_min ?? 30, max = th.notice_period_days_max ?? 90;
      if (nd != null && nd < min) findings.push({ ...base, level: "minor", explanation: `Preaviso de ${nd} días, inferior al mínimo recomendado (${min}).`, approver_role: String(r.minor_approver ?? "legal") });
      else if (nd != null && nd > max) findings.push({ ...base, level: "major", explanation: `Preaviso de ${nd} días supera el máximo (${max}): riesgo de quedar atrapados.`, approver_role: String(r.major_approver ?? "legal_director") });
      else findings.push({ ...base, level: "ok", explanation: `Renovación${p.renewal === "auto" ? " automática" : ""}${nd != null ? ` con preaviso de ${nd} días` : ""}: dentro de política.` });
      continue;
    }
    findings.push({ ...base, level: "ok", explanation: `Cláusula de ${CATEGORIES[cat] ?? cat} presente.` });
  }
  const order = { prohibited: 0, missing: 1, major: 2, minor: 3, ok: 4 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { findings, playbook: pb };
}
/** Riesgo 0-100 explicable (cap. 24). */
export function computeRisk(ctx: Ctx, c: Row, findings: Finding[]): { score: number; level: string; factors: { factor: string; weight: number; value: number; contribution: number; explanation: string }[] } {
  const f: { factor: string; weight: number; value: number; contribution: number; explanation: string }[] = [];
  const add = (factor: string, weight: number, value: number, explanation: string) => { value = Math.max(0, Math.min(1, value)); f.push({ factor, weight, value, contribution: Math.round(weight * value * 100) / 100, explanation }); };
  const n = (lvl: string) => findings.filter((x) => x.level === lvl).length;
  add("Desviaciones prohibidas", 25, n("prohibited"), `${n("prohibited")} hallazgos prohibidos`);
  add("Desviaciones mayores", 15, n("major") * 0.34, `${n("major")} desviaciones mayores`);
  add("Cláusulas obligatorias ausentes", 15, n("missing") * 0.5, `${n("missing")} cláusulas obligatorias ausentes`);
  const v = Number(c.total_value) || 0; add("Valor del contrato", 10, v < 10000 ? 0.1 : v < 100000 ? 0.4 : v < 1000000 ? 0.7 : 1, `Valor ${fmtMoney(v, String(c.currency || "EUR"))}`);
  const tm = Number(c.term_months) || (c.term_type === "indefinite" ? 999 : 0); add("Duración", 5, tm < 12 ? 0.2 : tm < 36 ? 0.5 : 1, c.term_type === "indefinite" ? "Duración indefinida" : `${tm} meses`);
  add("Renovación automática", 5, c.renewal_type === "auto" ? (Number(c.notice_period_days) < 30 ? 1 : 0.5) : 0, c.renewal_type === "auto" ? `Automática con preaviso de ${c.notice_period_days ?? "?"} días` : "Sin renovación automática");
  const law = String(c.governing_law || "ES"); add("Ley / jurisdicción", 5, law === "ES" ? 0 : EEA.has(law) ? 0.3 : 1, `Ley aplicable ${law}`);
  const hasDpa = findings.some((x) => x.category === "F02" && x.level !== "missing"); add("Datos personales", 8, c.contains_personal_data ? (!hasDpa ? 1 : c.international_transfer || c.counterparty_outside_eea ? 0.5 : 0) : 0, c.contains_personal_data ? (hasDpa ? "Con DPA" : "Sin cláusula DPA detectada") : "Sin datos personales");
  add("Papel de la contraparte", 3, c.paper_origin === "theirs" ? 1 : 0, c.paper_origin === "theirs" ? "Redactado por la contraparte" : "Nuestra plantilla");
  const prevCount = c.counterparty_company_id ? (ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM contracts WHERE workspace_id=? AND counterparty_company_id=? AND status IN ('ACTIVE','EXPIRED','RENEWED','TERMINATED') AND id<>?", ctx.ws, c.counterparty_company_id, c.id)?.n ?? 0) : 0;
  add("Contraparte sin historial", 4, prevCount ? 0 : 1, prevCount ? `${prevCount} contratos previos` : "Primera contratación con esta contraparte");
  add("Responsabilidad ilimitada", 5, findings.some((x) => x.category === "E01" && x.level === "prohibited") ? 1 : 0, "");
  const score = Math.min(100, Math.round(f.reduce((a, x) => a + x.contribution, 0)));
  const level = score <= 25 ? "low" : score <= 50 ? "medium" : score <= 75 ? "high" : "critical";
  return { score, level, factors: f.filter((x) => x.contribution > 0 || x.factor === "Valor del contrato") };
}
/** Ejecuta extracción + playbook + riesgo sobre la versión actual y persiste contract_clauses y riesgo. */
export function analyzeContract(ctx: Ctx, cid: string, opts: { actor?: "user" | "system" | "agent" } = {}): { findings: Finding[]; risk: ReturnType<typeof computeRisk>; meta: Record<string, unknown> } {
  const c = getContract(ctx, cid);
  const v = c.current_version_id ? ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id) : null;
  const text = String(v?.body ?? "");
  const ex = extractFromText(text);
  const fromTemplate = v ? ctx.db.all<Row>("SELECT * FROM contract_clauses WHERE contract_id=? AND version_id=? AND clause_id IS NOT NULL", cid, v.id) : [];
  for (const tc of fromTemplate) { const cat = String(tc.category); if (!ex.categories[cat]) ex.categories[cat] = { source_text: String(tc.text_final ?? "").slice(0, 200), params: {} }; }
  const { findings } = reviewAgainstPlaybook(ctx, c, ex);
  // metadatos sugeridos desde papel externo (no sobrescribe lo ya informado)
  const patch: Record<string, unknown> = {};
  if (c.paper_origin === "theirs" || c.source === "import") {
    if (ex.meta.payment_terms_days && !c.intake?.toString().includes("payment")) patch.payment_terms_days = ex.meta.payment_terms_days;
    if (ex.meta.governing_law && ex.meta.governing_law !== "XX") patch.governing_law = ex.meta.governing_law;
    if (ex.meta.notice_period_days && !c.notice_period_days) patch.notice_period_days = ex.meta.notice_period_days;
    if (ex.meta.renewal_type === "auto" && c.renewal_type === "none") patch.renewal_type = "auto";
    if (ex.meta.term_months && !c.term_months) { patch.term_months = ex.meta.term_months; patch.term_type = "fixed"; }
    if (ex.meta.contains_personal_data && !c.contains_personal_data) patch.contains_personal_data = 1;
  }
  const merged = { ...c, ...patch };
  const risk = computeRisk(ctx, merged, findings);
  if (v) {
    ctx.db.run("DELETE FROM contract_clauses WHERE contract_id=? AND version_id=? AND clause_id IS NULL", cid, v.id);
    let pos = fromTemplate.length;
    for (const [cat, info] of Object.entries(ex.categories)) {
      const fnd = findings.find((x) => x.category === cat);
      const tpl = fromTemplate.find((x) => x.category === cat);
      if (tpl) { ctx.db.update("contract_clauses", String(tpl.id), { status: fnd && fnd.level !== "ok" ? "modified" : "standard", deviation_level: fnd ? (fnd.level === "ok" ? "none" : fnd.level) : "none", deviation_summary: fnd?.explanation ?? null, approver_role: fnd?.approver_role ?? null, params: info.params }); continue; }
      ctx.db.insert("contract_clauses", { id: id(), workspace_id: ctx.ws, contract_id: cid, version_id: v.id, clause_id: null, category: cat, heading: CATEGORIES[cat] ?? cat, text_final: info.source_text, status: fnd && fnd.level !== "ok" ? "modified" : "standard", deviation_level: fnd ? (fnd.level === "ok" ? "none" : fnd.level) : "none", deviation_summary: fnd?.explanation ?? null, approver_role: fnd?.approver_role ?? null, suggested_clause_id: fnd?.suggested_clause_id ?? null, params: info.params, source_text: info.source_text, confidence: 0.9, position: pos++, created_at: now() });
    }
    for (const fnd of findings.filter((x) => x.level === "missing")) ctx.db.insert("contract_clauses", { id: id(), workspace_id: ctx.ws, contract_id: cid, version_id: v.id, clause_id: null, category: fnd.category, heading: CATEGORIES[fnd.category] ?? fnd.category, text_final: null, status: "missing", deviation_level: "missing", deviation_summary: fnd.explanation, approver_role: fnd.approver_role ?? null, suggested_clause_id: fnd.suggested_clause_id ?? null, params: {}, source_text: null, confidence: 1, position: pos++, created_at: now() });
  }
  const override = c.risk_override as string | null;
  ctx.db.update("contracts", cid, { ...patch, risk_score: risk.score, risk_level: override ?? risk.level, risk_factors: risk.factors, updated_at: now() });
  if (!v || text.length) tlog(ctx, cid, "analysis", `Análisis contra playbook: ${findings.filter((x) => x.level !== "ok").length} hallazgos · riesgo ${risk.score}`, null, { findings: findings.length }, opts.actor === "user" ? "user" : "agent", opts.actor === "user" ? undefined : "Agente de revisión");
  const dev = findings.filter((x) => x.level !== "ok").length;
  if (dev) emit(ctx, { type: "contract.deviation_detected", object: "contract", record: getContract(ctx, cid), meta: { deviations: dev } });
  return { findings, risk, meta: ex.meta };
}

/* ======================= contratos: creación, versiones, estados ======================= */
function ensureCompany(ctx: Ctx, input: ContractInput): string | null {
  if (input.counterparty_company_id) return input.counterparty_company_id;
  if (input.counterparty_name) {
    const ex = ctx.db.get<Row>("SELECT id FROM companies WHERE workspace_id=? AND lower(name)=lower(?) AND deleted_at IS NULL", ctx.ws, input.counterparty_name.trim());
    if (ex) return String(ex.id);
    const cidNew = id();
    ctx.db.insert("companies", { id: cidNew, workspace_id: ctx.ws, name: input.counterparty_name.trim(), type: "prospect", owner_id: ctx.user.id, tags: [], custom: {}, created_at: now(), updated_at: now() });
    return cidNew;
  }
  return null;
}
function assignLegalOwner(ctx: Ctx, _typeId: string): string | null {
  const legal = usersWithRole(ctx, "legal").concat(usersWithRole(ctx, "manager"));
  if (!legal.length) return usersWithRole(ctx, "admin")[0]?.id as string | null ?? null;
  // menor carga
  const load = legal.map((u) => ({ u, n: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM contracts WHERE workspace_id=? AND legal_owner_id=? AND status IN ('INTERNAL_REVIEW','NEGOTIATION','PENDING_APPROVAL')", ctx.ws, u.id)?.n ?? 0 }));
  load.sort((a, b) => a.n - b.n);
  return String(load[0]!.u.id);
}
export function createVersion(ctx: Ctx, cid: string, input: { body: string; branch?: "internal" | "external"; source?: string; comment?: string | null; file_name?: string | null; template_id?: string | null; major?: boolean; actorType?: "user" | "external" | "agent" }): Row {
  const c = ctx.db.get<Row>("SELECT * FROM contracts WHERE id=? AND workspace_id=?", cid, ctx.ws);
  if (!c) throw notFound("Contrato");
  if (c.signed_version_id) throw conflict("El contrato ya está firmado: el documento es inmutable. Crea una enmienda.");
  if (["PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED"].includes(String(c.status)) && input.source !== "system") {
    // cambiar versión durante aprobación/firma invalida aprobaciones y cancela sobres
    invalidateApprovals(ctx, cid, "Nueva versión del documento");
    ctx.db.all<Row>("SELECT id FROM signature_envelopes WHERE contract_id=? AND status IN ('sent','in_progress','draft')", cid).forEach((e) => ctx.db.update("signature_envelopes", String(e.id), { status: "cancelled" }));
    ctx.db.update("contracts", cid, { status: "INTERNAL_REVIEW", updated_at: now() });
    tlog(ctx, cid, "status", "Vuelve a revisión interna por cambio de versión");
  }
  const last = ctx.db.get<Row>("SELECT * FROM contract_versions WHERE contract_id=? ORDER BY major DESC, minor DESC LIMIT 1", cid);
  const sha = sha256(input.body);
  if (last && last.sha256 === sha) return last;
  const branch = input.branch ?? "internal";
  const major = !last ? 1 : input.major || branch === "external" ? Number(last.major) + 1 : Number(last.major);
  const minor = !last ? 0 : major !== Number(last.major) ? 0 : Number(last.minor) + 1;
  ctx.db.run("UPDATE contract_versions SET is_current=0 WHERE contract_id=?", cid);
  const vid = id();
  ctx.db.insert("contract_versions", { id: vid, workspace_id: ctx.ws, contract_id: cid, label: `${major}.${minor}`, major, minor, branch, source: input.source ?? "uploaded", body: input.body, file_name: input.file_name ?? null, sha256: sha, author_id: input.actorType === "external" ? null : ctx.user.id, comment: input.comment ?? null, is_current: 1, template_id: input.template_id ?? null, created_at: now() });
  ctx.db.update("contracts", cid, { current_version_id: vid, updated_at: now() });
  tlog(ctx, cid, "version", `Versión ${major}.${minor} (${branch === "external" ? "externa" : "interna"}) · ${input.source ?? "subida"}`, input.comment ?? null, { version_id: vid, sha256: sha }, input.actorType ?? "user");
  audit(ctx, "contract", cid, "version", { version: `${major}.${minor}`, sha256: sha });
  emit(ctx, { type: "contract.version_created", object: "contract", record: getContract(ctx, cid), meta: { branch, source: input.source } });
  return ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", vid) as Row;
}
export function generateFromTemplate(ctx: Ctx, cid: string, templateId: string, opts: { comment?: string } = {}): { version: Row; unresolved: string[] } {
  const c = getContract(ctx, cid);
  const t = ctx.db.get<Row>("SELECT * FROM clm_templates WHERE id=? AND workspace_id=?", templateId, ctx.ws);
  if (!t) throw notFound("Plantilla");
  if (t.status === "retired") throw badRequest("La plantilla está retirada");
  const r = renderContractTemplate(ctx, String(t.body), templateContext(ctx, c));
  const watermark = `BORRADOR · ${c.number} · generado el ${fmtDateLong(now())} — no válido para firma\n\n`;
  const v = createVersion(ctx, cid, { body: watermark + r.text, branch: "internal", source: "generated", comment: opts.comment ?? `Generado desde plantilla «${t.name}»`, template_id: templateId, actorType: "user" });
  ctx.db.run("DELETE FROM contract_clauses WHERE contract_id=? AND version_id=?", cid, v.id);
  r.clauses.forEach((cl, i) => ctx.db.insert("contract_clauses", { id: id(), workspace_id: ctx.ws, contract_id: cid, version_id: v.id, clause_id: cl.clause_id, category: cl.category, heading: cl.heading, text_final: cl.text, status: "standard", deviation_level: "none", params: {}, source_text: cl.text.slice(0, 200), confidence: 1, position: i, created_at: now() }));
  return { version: v, unresolved: r.unresolved };
}
export function createContract(ctx: Ctx, input: ContractInput, opts: { source?: string } = {}): Row {
  assert(ctx, "contract", "create");
  input = applyDefaults(ctx, "contract", input);
  const t = getType(ctx, input.type_id);
  if ((input.payment_terms_days ?? 30) > 60 && !input.justification) throw badRequest("Plazo de pago superior a 60 días (Ley 3/2004): indica una justificación o reduce el plazo");
  const cpId = ensureCompany(ctx, input);
  if (input.contains_personal_data && !input.data_role) throw badRequest("Indica el rol de tratamiento de datos (responsable, encargado o corresponsable)");
  const cid = id();
  const custom = validateCustom(ctx, "contract", input.custom ?? {});
  const deal = input.deal_id ? ctx.db.get<Row>("SELECT * FROM deals WHERE id=?", input.deal_id) : null;
  const row: Record<string, unknown> = {
    id: cid, workspace_id: ctx.ws, number: nextNumber(ctx, String(t.number_prefix)), title: input.title, type_id: t.id, counterparty_company_id: cpId ?? (deal?.company_id as string | null) ?? null, deal_id: input.deal_id ?? null, quote_id: input.quote_id ?? null,
    owner_id: input.owner_id ?? ctx.user.id, legal_owner_id: input.legal_owner_id ?? assignLegalOwner(ctx, String(t.id)), department: input.department ?? null, status: "DRAFT", kind: "master",
    paper_origin: input.paper_origin ?? "ours", language: input.language ?? "es", governing_law: input.governing_law ?? "ES", jurisdiction: input.jurisdiction ?? null, arbitration: input.arbitration ? 1 : 0,
    requested_at: now(), effective_date: input.effective_date ?? null, end_date: input.end_date ?? null, term_type: input.term_type ?? "fixed", term_months: input.term_months ?? 12, renewal_type: input.renewal_type ?? "none", renewal_period_months: input.renewal_period_months ?? null,
    notice_period_days: input.notice_period_days ?? null, max_renewals: input.max_renewals ?? null, total_value: input.total_value ?? (deal ? Number(deal.amount) : 0), annual_value: input.annual_value ?? input.total_value ?? (deal ? Number(deal.amount) : 0), currency: input.currency ?? ctx.settings.currency, value_basis: input.value_basis ?? "fixed",
    payment_model: input.payment_model ?? "one_off", payment_terms_days: input.payment_terms_days ?? 30, confidentiality: input.confidentiality ?? "normal", contains_personal_data: input.contains_personal_data ? 1 : 0, data_role: input.data_role ?? null, international_transfer: input.international_transfer ? 1 : 0,
    dora_in_scope: input.dora_in_scope ? 1 : 0, public_sector: input.public_sector ? 1 : 0, counterparty_outside_eea: input.counterparty_outside_eea ? 1 : 0, urgency: input.urgency ?? "normal", description: input.description ?? null,
    tags: input.tags ?? [], custom, effective_values: {}, intake: { ...(input.intake ?? {}), justification: input.justification ?? null }, source: opts.source ?? "intake", sla_due_at: addDays(now(), (Number(t.sla_hours) / (input.urgency === "critical" ? 2 : 1)) / 24), created_by: ctx.user.id, created_at: now(), updated_at: now(), last_activity_at: now(),
  };
  Object.assign(row, computeDates(row));
  ctx.db.insert("contracts", row);
  audit(ctx, "contract", cid, "create", { number: row.number, title: input.title });
  tlog(ctx, cid, "created", `Solicitud creada (${t.name})`, input.description ?? null);
  if (input.body) createVersion(ctx, cid, { body: input.body, branch: input.paper_origin === "theirs" ? "external" : "internal", source: input.paper_origin === "theirs" ? "counterparty" : "uploaded", file_name: input.file_name ?? null, comment: input.paper_origin === "theirs" ? "Papel de la contraparte" : "Texto inicial" });
  else { const tplId = input.template_id ?? (t.default_template_id as string | null); if (tplId) generateFromTemplate(ctx, cid, tplId); }
  if (c_hasVersion(ctx, cid)) analyzeContract(ctx, cid, { actor: "agent" });
  if (row.legal_owner_id && row.legal_owner_id !== ctx.user.id) notify(ctx.db, ctx.ws, row.legal_owner_id as string, { type: "contract", title: `Nueva solicitud de contrato: ${row.number}`, body: input.title, link: `/contratos/${cid}` });
  if (deal) { tlog(ctx, cid, "crm", `Vinculado al negocio «${deal.name}»`); }
  emit(ctx, { type: "contract.created", object: "contract", record: getContract(ctx, cid) });
  return getContract(ctx, cid);
}
const c_hasVersion = (ctx: Ctx, cid: string) => !!ctx.db.get("SELECT id FROM contract_versions WHERE contract_id=? LIMIT 1", cid);
export function updateContract(ctx: Ctx, cid: string, patch: Partial<ContractInput>): Row {
  assert(ctx, "contract", "update");
  const prev = getContract(ctx, cid);
  const locked = ["OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ARCHIVED"].includes(String(prev.status));
  const data: Record<string, unknown> = { ...patch };
  delete data.body; delete data.file_name; delete data.template_id; delete data.counterparty_name; delete data.justification;
  if (patch.counterparty_name && !patch.counterparty_company_id) data.counterparty_company_id = ensureCompany(ctx, patch as ContractInput);
  for (const k of ["arbitration", "contains_personal_data", "international_transfer", "dora_in_scope", "public_sector", "counterparty_outside_eea"]) if (k in data) data[k] = data[k] ? 1 : 0;
  if (patch.custom) data.custom = validateCustom(ctx, "contract", patch.custom, (prev.custom as Record<string, unknown>) ?? {}, true);
  checkRequired(ctx, "contract", prev, data);
  if (locked) { const allowed = ["tags", "custom", "description", "department", "owner_id", "legal_owner_id", "confidentiality"]; for (const k of Object.keys(data)) if (!allowed.includes(k)) throw conflict("El contrato está en firma: solo se pueden editar etiquetas, descripción y responsables"); }
  if (prev.status === "ACTIVE" && ["total_value", "annual_value", "end_date", "notice_period_days", "renewal_type", "term_months"].some((k) => k in data)) throw conflict("El contrato está activo: los cambios de condiciones se hacen mediante una enmienda");
  const merged = { ...prev, ...data };
  Object.assign(data, computeDates(merged));
  data.updated_at = now();
  ctx.db.update("contracts", cid, data);
  const nxt = getContract(ctx, cid);
  const changes = diff(prev, nxt, ["updated_at", "last_activity_at", "risk_factors"]);
  if (Object.keys(changes).length) { audit(ctx, "contract", cid, "update", changes); emit(ctx, { type: "contract.updated", object: "contract", record: nxt, previous: prev, changes }); }
  if (["effective_date", "end_date", "notice_period_days", "term_months", "renewal_type"].some((k) => k in changes) && nxt.status === "ACTIVE") regenerateMilestones(ctx, cid);
  return nxt;
}
export function deleteContract(ctx: Ctx, cid: string) {
  assert(ctx, "contract", "delete");
  const c = getContract(ctx, cid);
  if (c.signed_version_id) throw conflict("Un contrato firmado no se borra: se termina y se conserva según la política de retención");
  if (c.legal_hold) throw conflict("Contrato bajo bloqueo legal");
  ctx.db.update("contracts", cid, { deleted_at: now(), updated_at: now() });
  audit(ctx, "contract", cid, "delete", {});
}

/* ---------- aprobaciones ---------- */
interface ApprovalStep { name: string; reason: string; approver_user_id: string | null; approver_role: string; sla_hours: number }
function resolveApprover(ctx: Ctx, ref: string, c: Row): { user: string | null; role: string } {
  if (ref === "manager_of_requester") return { user: managerOf(ctx, c.owner_id as string), role: "manager" };
  if (ref === "legal_owner") return { user: (c.legal_owner_id as string) ?? assignLegalOwner(ctx, String(c.type_id)), role: "legal" };
  if (ref.startsWith("user:")) return { user: ref.slice(5), role: roleKeyOf(ctx, ref.slice(5)) || "user" };
  const map: Record<string, string[]> = { legal: ["legal", "manager", "admin"], legal_director: ["legal_director", "admin", "manager"], cfo: ["cfo", "finance", "admin"], dpo: ["dpo", "admin"], ceo: ["ceo", "admin"], department_head: ["manager", "admin"], admin: ["admin"] };
  for (const rk of map[ref] ?? [ref, "admin"]) { const u = usersWithRole(ctx, rk).find((x) => x.id !== c.owner_id) ?? usersWithRole(ctx, rk)[0]; if (u) return { user: String(u.id), role: ref }; }
  return { user: null, role: ref };
}
/** Calcula los pasos de aprobación aplicables (reglas del tipo o política por defecto del cap. 13). */
export function computeApprovalSteps(ctx: Ctx, c: Row, findings?: Finding[]): ApprovalStep[] {
  const t = getType(ctx, String(c.type_id));
  const dev = findings ?? ctx.db.all<Row>("SELECT deviation_level FROM contract_clauses WHERE contract_id=? AND version_id=?", c.id, c.current_version_id).map((r) => ({ level: r.deviation_level as Finding["level"], category: "" } as Finding));
  const cnt = (lvl: string) => dev.filter((d) => d.level === lvl).length;
  const value = Number(c.total_value) || 0; const term = Number(c.term_months) || 0;
  const rules = ((t.approval_rules as Record<string, unknown>[]) ?? []);
  const vars: Record<string, unknown> = { value, annual_value: Number(c.annual_value) || 0, term_months: term, payment_terms_days: Number(c.payment_terms_days) || 0, minor: cnt("minor"), major: cnt("major"), prohibited: cnt("prohibited"), missing: cnt("missing"), deviations: dev.filter((d) => d.level !== "ok").length, paper_theirs: c.paper_origin === "theirs", personal_data: !!c.contains_personal_data, outside_eea: !!c.counterparty_outside_eea || !!c.international_transfer, risk_score: Number(c.risk_score) || 0, exclusivity: dev.some((d) => d.category === "H01" && d.level !== "ok"), urgency: c.urgency, direction: t.direction };
  const steps: ApprovalStep[] = [];
  const push = (name: string, ref: string, reason: string, sla = 48) => {
    let a = resolveApprover(ctx, ref, c);
    if (a.user && a.user === c.owner_id) {
      // separación de funciones: el solicitante no aprueba su propio contrato
      const alts = [resolveApprover(ctx, "manager_of_requester", c), resolveApprover(ctx, "admin", c), { user: (ctx.db.get<Row>("SELECT id FROM users WHERE workspace_id=? AND active=1 AND id<>? ORDER BY created_at LIMIT 1", ctx.ws, c.owner_id)?.id as string | undefined) ?? null, role: "user" }];
      const alt = alts.find((x) => x.user && x.user !== c.owner_id);
      if (alt) { a = { user: alt.user, role: alt.role }; reason += " (separación de funciones)"; }
    }
    const existing = steps.find((s) => s.approver_user_id && s.approver_user_id === a.user);
    if (existing) { existing.name = `${existing.name} + ${name}`; existing.reason = `${existing.reason} · ${reason}`; existing.sla_hours = Math.min(existing.sla_hours, sla); return; }
    steps.push({ name, reason, approver_user_id: a.user, approver_role: a.role, sla_hours: sla });
  };
  if (rules.length) {
    for (const r of rules) { const cond = String(r.when ?? "always"); const ok = cond === "always" || cond.split("||").some((or) => or.split("&&").every((e) => evalExpr(e.trim(), vars))); if (ok) push(String(r.name ?? r.approver), String(r.approver ?? "legal"), `Regla: ${cond}`, Number(r.sla_hours ?? 48)); }
    return steps;
  }
  if (!(value < 5000 && vars.deviations === 0)) push("Aprobación de negocio", "manager_of_requester", value >= 5000 ? `Valor ${fmtMoney(value, String(c.currency))} ≥ 5.000 €` : "Hay desviaciones del playbook");
  if (cnt("minor") + cnt("major") + cnt("missing") > 0 || c.paper_origin === "theirs") push("Legal", "legal_owner", c.paper_origin === "theirs" ? "Papel de la contraparte" : "Desviaciones del playbook", 72);
  if (cnt("major") + cnt("prohibited") + cnt("missing") > 0) push("Director legal", "legal_director", `${cnt("major")} desviaciones mayores, ${cnt("prohibited")} prohibidas, ${cnt("missing")} ausentes`);
  if (value >= 50000 || Number(c.payment_terms_days) > 60 || c.payment_model === "usage") push("Finanzas", "cfo", value >= 50000 ? `Valor ≥ 50.000 €` : Number(c.payment_terms_days) > 60 ? "Plazo de pago > 60 días" : "Modelo de pago por uso");
  if (c.contains_personal_data && (vars.outside_eea || !dev.some((d) => d.category === "F02" && d.level === "ok"))) push("DPO", "dpo", vars.outside_eea ? "Datos personales con transferencia fuera del EEE" : "Datos personales sin DPA conforme");
  if (value >= 250000 || term > 36 || cnt("prohibited") > 0 || vars.exclusivity) push("Dirección general", "ceo", value >= 250000 ? "Valor ≥ 250.000 €" : term > 36 ? "Duración > 36 meses" : cnt("prohibited") ? "Cláusula prohibida" : "Exclusividad");
  return steps;
}
export function requestApproval(ctx: Ctx, cid: string): { steps: ApprovalStep[]; auto: boolean } {
  const c = getContract(ctx, cid);
  if (!["INTERNAL_REVIEW", "NEGOTIATION", "DRAFT"].includes(String(c.status))) throw conflict(`No se puede pedir aprobación en estado ${c.status}`);
  const v = c.current_version_id ? ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id) : null;
  if (!v) throw badRequest("El contrato no tiene documento: genera o sube una versión");
  if (/\[[a-z_]+\.[a-z_.]+\]/i.test(String(v.body)) && String(v.source) === "generated") throw badRequest("La versión tiene variables sin resolver: completa los datos y vuelve a generar");
  const { findings } = analyzeContract(ctx, cid, { actor: "agent" });
  const steps = computeApprovalSteps(ctx, getContract(ctx, cid), findings);
  ctx.db.run("UPDATE contract_versions SET locked=1, is_final=1 WHERE id=?", v.id);
  ctx.db.run("DELETE FROM contract_approvals WHERE contract_id=? AND status='pending'", cid);
  if (!steps.length) {
    setStatus(ctx, cid, "APPROVED", `Aprobación automática por política (sin pasos aplicables) · hash ${String(v.sha256).slice(0, 12)}`);
    ctx.db.insert("contract_approvals", { id: id(), workspace_id: ctx.ws, contract_id: cid, version_id: v.id, version_sha256: v.sha256, step_order: 0, step_name: "Aprobación automática", reason: "Ningún paso aplicable según la política", approver_user_id: null, approver_role: "policy", status: "approved", decided_at: now(), decided_by: null, comment: "auto-approved by policy", created_at: now() });
    return { steps, auto: true };
  }
  steps.forEach((s, i) => { ctx.db.insert("contract_approvals", { id: id(), workspace_id: ctx.ws, contract_id: cid, version_id: v.id, version_sha256: v.sha256, step_order: i + 1, step_name: s.name, reason: s.reason, approver_user_id: s.approver_user_id, approver_role: s.approver_role, status: "pending", due_at: addDays(now(), s.sla_hours / 24), created_at: now() }); });
  setStatus(ctx, cid, "PENDING_APPROVAL", `${steps.length} pasos de aprobación`);
  const first = steps[0]!;
  if (first.approver_user_id) notify(ctx.db, ctx.ws, first.approver_user_id, { type: "approval", title: `Aprobación pendiente: ${c.number}`, body: `${c.title} · ${first.name} · ${first.reason}`, link: `/contratos/${cid}?tab=approvals` });
  emit(ctx, { type: "approval.requested", object: "contract", record: getContract(ctx, cid) });
  return { steps, auto: false };
}
export function invalidateApprovals(ctx: Ctx, cid: string, reason: string) {
  const n = ctx.db.all<Row>("SELECT id FROM contract_approvals WHERE contract_id=? AND status IN ('pending','approved')", cid);
  n.forEach((a) => ctx.db.update("contract_approvals", String(a.id), { status: "invalidated", comment: reason }));
  if (n.length) tlog(ctx, cid, "approval", `Aprobaciones invalidadas: ${reason}`);
}
export function decideApproval(ctx: Ctx, approvalId: string, decision: "approved" | "rejected", comment?: string | null, conditions?: string | null) {
  const a = ctx.db.get<Row>("SELECT * FROM contract_approvals WHERE id=? AND workspace_id=?", approvalId, ctx.ws);
  if (!a) throw notFound("Aprobación");
  if (a.status !== "pending") throw conflict("Esta aprobación ya está decidida");
  if (a.approver_user_id !== ctx.user.id && !isAdmin(ctx)) throw forbidden("No eres el aprobador de este paso");
  const c = getContract(ctx, String(a.contract_id));
  const v = ctx.db.get<Row>("SELECT sha256 FROM contract_versions WHERE id=?", c.current_version_id);
  if (v?.sha256 !== a.version_sha256) throw conflict("La versión del documento ha cambiado desde que se pidió la aprobación");
  if (decision === "rejected" && !comment) throw badRequest("Indica el motivo del rechazo");
  ctx.db.update("contract_approvals", approvalId, { status: decision, decided_at: now(), decided_by: ctx.user.id, comment: comment ?? null, conditions: conditions ?? null });
  tlog(ctx, String(c.id), "approval", `${a.step_name}: ${decision === "approved" ? "aprobado" : "rechazado"}${conditions ? ` (condicionado: ${conditions})` : ""}`, comment ?? null);
  audit(ctx, "contract", String(c.id), decision === "approved" ? "approve" : "reject", { step: a.step_name, comment });
  if (decision === "rejected") {
    ctx.db.run("UPDATE contract_approvals SET status='skipped' WHERE contract_id=? AND status='pending'", c.id);
    setStatus(ctx, String(c.id), "REJECTED", `Rechazado en «${a.step_name}»: ${comment}`);
    notify(ctx.db, ctx.ws, c.owner_id as string, { type: "approval", title: `Contrato rechazado: ${c.number}`, body: String(comment), link: `/contratos/${c.id}?tab=approvals` });
    emit(ctx, { type: "approval.decided", object: "contract", record: getContract(ctx, String(c.id)), meta: { status: "rejected" } });
    return;
  }
  if (conditions) createTask(ctx, { title: `Condición de aprobación (${c.number}): ${conditions}`, type: "todo", due_at: addDays(now(), 2), assignee_id: c.legal_owner_id as string | null ?? ctx.user.id, deal_id: (c.deal_id as string) ?? null, company_id: (c.counterparty_company_id as string) ?? null } as never, { silent: true });
  const pending = ctx.db.all<Row>("SELECT * FROM contract_approvals WHERE contract_id=? AND status='pending' ORDER BY step_order", c.id);
  if (!pending.length) {
    setStatus(ctx, String(c.id), "APPROVED", "Todas las aprobaciones completadas");
    notify(ctx.db, ctx.ws, c.owner_id as string, { type: "approval", title: `Contrato aprobado: ${c.number}`, body: "Listo para enviar a firma", link: `/contratos/${c.id}?tab=signature` });
  } else { const nxt = pending[0]!; if (nxt.approver_user_id) notify(ctx.db, ctx.ws, String(nxt.approver_user_id), { type: "approval", title: `Aprobación pendiente: ${c.number}`, body: `${c.title} · ${nxt.step_name}`, link: `/contratos/${c.id}?tab=approvals` }); }
  emit(ctx, { type: "approval.decided", object: "contract", record: getContract(ctx, String(c.id)), meta: { status: "approved" } });
}
export function delegateApproval(ctx: Ctx, approvalId: string, toUser: string, reason: string) {
  const a = ctx.db.get<Row>("SELECT * FROM contract_approvals WHERE id=? AND workspace_id=?", approvalId, ctx.ws);
  if (!a || a.status !== "pending") throw notFound("Aprobación pendiente");
  if (a.approver_user_id !== ctx.user.id && !isAdmin(ctx)) throw forbidden("Solo el aprobador puede delegar");
  ctx.db.update("contract_approvals", approvalId, { approver_user_id: toUser, comment: `Delegada por ${ctx.user.name}: ${reason}` });
  tlog(ctx, String(a.contract_id), "approval", `${a.step_name} delegada a ${userName(ctx, toUser)}`, reason);
  notify(ctx.db, ctx.ws, toUser, { type: "approval", title: "Aprobación delegada", body: `${a.step_name}: ${reason}`, link: `/contratos/${a.contract_id}?tab=approvals` });
}

/* ---------- máquina de estados ---------- */
function setStatus(ctx: Ctx, cid: string, to: string, note?: string | null, actorType: "user" | "system" | "external" | "agent" = "user") {
  const c = ctx.db.get<Row>("SELECT * FROM contracts WHERE id=?", cid) as Row;
  if (actorType === "user") checkRequired(ctx, "contract", { ...c, custom: typeof c.custom === "string" ? JSON.parse(c.custom || "{}") : c.custom }, { status: to });
  const from = String(c.status);
  if (from === to) return;
  ctx.db.update("contracts", cid, { status: to, prev_status: from, substatus: null, sla_paused: ["NEGOTIATION", "ON_HOLD"].includes(to) ? 1 : 0, updated_at: now() });
  audit(ctx, "contract", cid, "status_change", { status: [from, to], note });
  tlog(ctx, cid, "status", `${STATUS_LABEL[from] ?? from} → ${STATUS_LABEL[to] ?? to}`, note ?? null, { from, to }, actorType);
  emit(ctx, { type: "contract.status_changed", object: "contract", record: getContract(ctx, cid), previous: parseJson(c, JC), changes: { status: [from, to] }, meta: { from, to } });
}
export const STATUS_LABEL: Record<string, string> = { DRAFT: "Borrador", INTERNAL_REVIEW: "Revisión interna", NEGOTIATION: "Negociación", PENDING_APPROVAL: "Pendiente de aprobación", APPROVED: "Aprobado", OUT_FOR_SIGNATURE: "En firma", PARTIALLY_SIGNED: "Firmado parcialmente", ACTIVE: "Activo", EXPIRED: "Vencido", TERMINATED: "Terminado", RENEWED: "Renovado", CANCELLED: "Cancelado", REJECTED: "Rechazado", ON_HOLD: "En pausa", ARCHIVED: "Archivado" };
export const TRANSITIONS: Record<string, { from: string[]; to: string; label: string }> = {
  submit_for_review: { from: ["DRAFT", "REJECTED"], to: "INTERNAL_REVIEW", label: "Enviar a revisión" },
  return_to_requester: { from: ["INTERNAL_REVIEW", "NEGOTIATION"], to: "DRAFT", label: "Devolver al solicitante" },
  send_to_counterparty: { from: ["INTERNAL_REVIEW", "DRAFT"], to: "NEGOTIATION", label: "Enviar a la contraparte" },
  counterparty_version_received: { from: ["NEGOTIATION"], to: "INTERNAL_REVIEW", label: "Versión de la contraparte recibida" },
  request_approval: { from: ["INTERNAL_REVIEW", "NEGOTIATION", "DRAFT"], to: "PENDING_APPROVAL", label: "Pedir aprobación" },
  reopen: { from: ["APPROVED", "REJECTED", "CANCELLED"], to: "INTERNAL_REVIEW", label: "Reabrir" },
  send_for_signature: { from: ["APPROVED"], to: "OUT_FOR_SIGNATURE", label: "Enviar a firma" },
  cancel: { from: ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "ON_HOLD", "REJECTED"], to: "CANCELLED", label: "Cancelar" },
  put_on_hold: { from: ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED"], to: "ON_HOLD", label: "Pausar" },
  resume: { from: ["ON_HOLD"], to: "__prev", label: "Reanudar" },
  terminate: { from: ["ACTIVE"], to: "TERMINATED", label: "Terminar" },
  archive: { from: ["EXPIRED", "TERMINATED", "RENEWED", "CANCELLED", "REJECTED"], to: "ARCHIVED", label: "Archivar" },
};
export function availableTransitions(c: Row): string[] { return Object.entries(TRANSITIONS).filter(([, t]) => t.from.includes(String(c.status))).map(([k]) => k); }
export function transition(ctx: Ctx, cid: string, event: string, payload: Record<string, unknown> = {}): Row {
  assert(ctx, "contract", "update");
  const c = getContract(ctx, cid);
  const t = TRANSITIONS[event];
  if (!t) throw badRequest(`Evento desconocido: ${event}`);
  if (!t.from.includes(String(c.status))) throw conflict(`No se puede «${t.label}» desde ${STATUS_LABEL[String(c.status)]}`);
  const note = payload.note ? String(payload.note) : null;
  switch (event) {
    case "submit_for_review": {
      const tp = getType(ctx, String(c.type_id));
      if (!c.counterparty_company_id) throw badRequest("Indica la contraparte antes de enviar a revisión");
      if (!c.current_version_id) throw badRequest("Genera o sube el documento antes de enviar a revisión");
      if (tp.requires_dpa && c.contains_personal_data && c.data_role === "processor") { const hasDpa = ctx.db.get("SELECT id FROM contract_clauses WHERE contract_id=? AND version_id=? AND category='F02' AND status<>'missing'", cid, c.current_version_id); if (!hasDpa) tlog(ctx, cid, "warning", "Aviso: trata datos como encargado y no se detecta cláusula DPA (art. 28 RGPD)"); }
      const legal = (c.legal_owner_id as string) ?? assignLegalOwner(ctx, String(c.type_id));
      ctx.db.update("contracts", cid, { legal_owner_id: legal, sla_due_at: addDays(now(), Number(tp.sla_hours) / 24) });
      setStatus(ctx, cid, "INTERNAL_REVIEW", note);
      if (legal) notify(ctx.db, ctx.ws, legal, { type: "contract", title: `Revisión legal: ${c.number}`, body: c.title as string, link: `/contratos/${cid}` });
      break;
    }
    case "send_to_counterparty": {
      if (!c.current_version_id) throw badRequest("No hay documento que enviar");
      const v = ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id)!;
      if (v.branch !== "external") { ctx.db.run("UPDATE contract_versions SET is_current=0 WHERE contract_id=?", cid); const vid = id(); const major = Number(v.major) + 1; ctx.db.insert("contract_versions", { id: vid, workspace_id: ctx.ws, contract_id: cid, label: `${major}.0`, major, minor: 0, branch: "external", source: "generated", body: v.body, file_name: v.file_name, sha256: v.sha256, author_id: ctx.user.id, comment: "Enviada a la contraparte", is_current: 1, template_id: v.template_id, created_at: now() }); ctx.db.update("contracts", cid, { current_version_id: vid }); }
      setStatus(ctx, cid, "NEGOTIATION", note ?? "Documento enviado a la contraparte");
      const contact = payload.contact_email ? String(payload.contact_email) : (c.counterparty_company_id ? ctx.db.get<{ email: string }>("SELECT email FROM contacts WHERE company_id=? AND email IS NOT NULL AND deleted_at IS NULL LIMIT 1", c.counterparty_company_id)?.email : null);
      if (contact) void sendMail(ctx.db, ctx.ws, { to: contact, subject: `${ctx.settings.company_name}: propuesta de ${c.title} (${c.number})`, html: `<p>Adjuntamos nuestra propuesta de contrato <b>${c.title}</b> (ref. ${c.number}) para su revisión.</p><p>${note ?? ""}</p>`, track: false });
      break;
    }
    case "counterparty_version_received": {
      if (!payload.body) throw badRequest("Adjunta el texto recibido");
      createVersion(ctx, cid, { body: String(payload.body), branch: "external", source: "counterparty", comment: note ?? "Versión recibida de la contraparte", file_name: payload.file_name ? String(payload.file_name) : null });
      setStatus(ctx, cid, "INTERNAL_REVIEW", "Versión de la contraparte recibida: comparada y analizada");
      analyzeContract(ctx, cid, { actor: "agent" });
      if (c.legal_owner_id) notify(ctx.db, ctx.ws, c.legal_owner_id as string, { type: "contract", title: `Versión de la contraparte: ${c.number}`, body: "Revisa la comparación y los hallazgos del playbook", link: `/contratos/${cid}?tab=versions` });
      break;
    }
    case "request_approval": requestApproval(ctx, cid); break;
    case "reopen": invalidateApprovals(ctx, cid, "Contrato reabierto"); ctx.db.run("UPDATE contract_versions SET locked=0 WHERE contract_id=?", cid); setStatus(ctx, cid, "INTERNAL_REVIEW", note); break;
    case "send_for_signature": return sendForSignature(ctx, cid, payload as never);
    case "cancel": { if (!note) throw badRequest("Indica el motivo de la cancelación"); invalidateApprovals(ctx, cid, "Cancelado"); setStatus(ctx, cid, "CANCELLED", note); break; }
    case "put_on_hold": setStatus(ctx, cid, "ON_HOLD", note); break;
    case "resume": setStatus(ctx, cid, String(c.prev_status ?? "DRAFT"), note); break;
    case "return_to_requester": { setStatus(ctx, cid, "DRAFT", note); createTask(ctx, { title: `Completar solicitud de contrato ${c.number}${note ? `: ${note}` : ""}`, type: "todo", due_at: addDays(now(), 2), assignee_id: (c.owner_id as string) ?? ctx.user.id, company_id: (c.counterparty_company_id as string) ?? null } as never, { silent: true }); break; }
    case "terminate": return terminateContract(ctx, cid, payload as never);
    case "archive": { const open = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM obligations WHERE contract_id=? AND status IN ('pending','in_progress') AND survives_termination=0", cid)?.n ?? 0; if (open) throw conflict(`Hay ${open} obligaciones abiertas no supervivientes`); setStatus(ctx, cid, "ARCHIVED", note); break; }
  }
  return getContract(ctx, cid);
}

/* ======================= firma electrónica (SES propia) ======================= */
export const signerSchema = z.object({ name: z.string().trim().min(1), email: z.string().trim().email(), party: z.enum(["us", "them"]).optional(), role: z.enum(["signer", "approver", "cc", "witness"]).optional(), title: nullStr, contact_id: z.string().nullable().optional(), user_id: z.string().nullable().optional(), order_no: z.number().int().min(1).optional() });
export function checkSignatureAuthority(ctx: Ctx, userId: string, c: Row): string | null {
  const t = getType(ctx, String(c.type_id));
  const auths = ctx.db.all<Row>("SELECT * FROM signature_authority WHERE workspace_id=? AND user_id=? AND active=1", ctx.ws, userId).map((a) => parseJson(a, ["type_codes"]));
  const td = today();
  const ok = auths.find((a) => { const codes = a.type_codes as string[]; return (!codes.length || codes.includes(String(t.code))) && (!a.valid_from || String(a.valid_from) <= td) && (!a.valid_to || String(a.valid_to) >= td) && (a.max_value == null || Number(a.max_value) >= Number(c.total_value)); });
  if (ok) return null;
  if (!auths.length) return `${userName(ctx, userId)} no tiene poderes de firma registrados`;
  return `${userName(ctx, userId)} no tiene autoridad vigente para firmar ${t.name} por ${fmtMoney(c.total_value, String(c.currency))}`;
}
export function preSignatureChecklist(ctx: Ctx, cid: string, signers: z.infer<typeof signerSchema>[]): { errors: string[]; warnings: string[] } {
  const c = getContract(ctx, cid); const errors: string[] = []; const warnings: string[] = [];
  const v = c.current_version_id ? ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id) : null;
  if (!v) errors.push("No hay documento");
  else { const body = String(v.body); if (/\[[a-z_]+\.[a-z_.]+\]/i.test(body)) errors.push("El texto tiene variables sin resolver"); if (/BORRADOR/.test(body.slice(0, 200))) warnings.push("La versión conserva la marca de agua de borrador: se retirará en el documento final"); if (/\[\s*\]/.test(body)) errors.push("Hay campos vacíos «[ ]» en el texto"); }
  if (!c.counterparty_company_id) errors.push("Falta la contraparte");
  if (c.effective_date && c.end_date && c.effective_date > c.end_date) errors.push("La fecha de inicio es posterior a la de fin");
  if (c.notice_period_days && c.term_months && Number(c.notice_period_days) > Number(c.term_months) * 30) errors.push("El preaviso es mayor que la duración");
  const approved = ctx.db.get<Row>("SELECT version_sha256 FROM contract_approvals WHERE contract_id=? AND status='approved' ORDER BY decided_at DESC LIMIT 1", cid);
  if (!approved) errors.push("No hay aprobaciones completadas"); else if (v && approved.version_sha256 !== v.sha256) errors.push("La versión aprobada no coincide con la actual");
  const us = signers.filter((s) => s.party === "us" && (s.role ?? "signer") === "signer");
  if (!us.length) errors.push("Falta al menos un firmante interno");
  for (const s of us) { if (!s.user_id) { warnings.push(`${s.name}: firmante interno sin usuario asociado (no se valida la autoridad)`); continue; } const err = checkSignatureAuthority(ctx, s.user_id, c); if (err) errors.push(err); }
  const joint = us.some((s) => s.user_id && ctx.db.get("SELECT id FROM signature_authority WHERE user_id=? AND requires_joint=1 AND active=1", s.user_id));
  if (joint && us.length < 2) errors.push("Firma mancomunada: se requieren dos firmantes internos");
  if (!signers.some((s) => s.party !== "us" && (s.role ?? "signer") === "signer")) warnings.push("No hay firmante de la contraparte");
  const t = getType(ctx, String(c.type_id));
  if (t.requires_kyc && c.counterparty_company_id) { const co = ctx.db.get<Row>("SELECT tax_id FROM companies WHERE id=?", c.counterparty_company_id); if (!co?.tax_id) errors.push("KYC: la contraparte no tiene CIF registrado"); }
  return { errors, warnings };
}
export function sendForSignature(ctx: Ctx, cid: string, payload: { signers?: z.infer<typeof signerSchema>[]; level?: string; message?: string; expires_days?: number }): Row {
  const c = getContract(ctx, cid);
  if (c.status !== "APPROVED") throw conflict("El contrato debe estar aprobado");
  const signers = z.array(signerSchema).min(1).parse(payload.signers ?? []);
  const chk = preSignatureChecklist(ctx, cid, signers);
  if (chk.errors.length) throw badRequest(`Checklist pre-firma: ${chk.errors.join(" · ")}`);
  const t = getType(ctx, String(c.type_id));
  const levels = ["SES", "AdES", "QES"]; const level = payload.level ?? String(t.min_signature_level);
  if (levels.indexOf(level) < levels.indexOf(String(t.min_signature_level))) throw badRequest(`Este tipo exige nivel de firma ${t.min_signature_level}`);
  const v = ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id) as Row;
  const finalBody = String(v.body).replace(/^BORRADOR[^\n]*\n\n?/, "");
  const fv = finalBody !== v.body ? createVersion(ctx, cid, { body: finalBody, branch: "internal", source: "system", comment: "Documento final para firma (sin marca de agua)" }) : v;
  ctx.db.run("UPDATE contract_versions SET locked=1, is_final=1 WHERE id=?", fv.id);
  const eid = id();
  ctx.db.insert("signature_envelopes", { id: eid, workspace_id: ctx.ws, contract_id: cid, version_id: fv.id, version_sha256: fv.sha256, level, status: "sent", message: payload.message ?? null, sent_at: now(), expires_at: addDays(now(), payload.expires_days ?? 30), evidence: { generated_by: ctx.user.name, legal_text_version: "v1-2026" }, created_by: ctx.user.id, created_at: now() });
  signers.forEach((s, i) => {
    const sid = id(); const tk = token(24);
    ctx.db.insert("signers", { id: sid, workspace_id: ctx.ws, envelope_id: eid, contact_id: s.contact_id ?? null, user_id: s.user_id ?? null, name: s.name, email: s.email.toLowerCase(), order_no: s.order_no ?? i + 1, role: s.role ?? "signer", party: s.party ?? "them", title: s.title ?? null, status: "pending", token: tk, created_at: now() });
    ctx.db.insert("signature_events", { id: id(), workspace_id: ctx.ws, envelope_id: eid, signer_id: sid, type: "sent", at: now(), ip: ctx.ip, meta: {} });
    void sendMail(ctx.db, ctx.ws, { to: s.email, subject: `Firma requerida: ${c.title} (${c.number})`, html: `<p>Hola ${s.name},</p><p>${ctx.settings.company_name} te invita a firmar electrónicamente el documento <b>${c.title}</b>.</p>${payload.message ? `<p>${payload.message}</p>` : ""}<p><a href="/s/${tk}">Revisar y firmar</a> · El enlace caduca en ${payload.expires_days ?? 30} días.</p>`, track: false });
  });
  setStatus(ctx, cid, "OUT_FOR_SIGNATURE", `Sobre enviado a ${signers.length} firmantes (${level})`);
  if (c.deal_id) ctx.db.run("UPDATE deals SET updated_at=? WHERE id=?", now(), c.deal_id);
  emit(ctx, { type: "envelope.sent", object: "contract", record: getContract(ctx, cid) });
  return getContract(ctx, cid);
}
export function remindEnvelope(ctx: Ctx, eid: string) {
  const e = ctx.db.get<Row>("SELECT * FROM signature_envelopes WHERE id=? AND workspace_id=?", eid, ctx.ws); if (!e) throw notFound("Sobre");
  const pending = ctx.db.all<Row>("SELECT * FROM signers WHERE envelope_id=? AND status='pending'", eid);
  const c = getContract(ctx, String(e.contract_id));
  for (const s of pending) { void sendMail(ctx.db, ctx.ws, { to: String(s.email), subject: `Recordatorio de firma: ${c.title}`, html: `<p>Tienes pendiente firmar <b>${c.title}</b>: <a href="/s/${s.token}">firmar ahora</a>.</p>`, track: false }); ctx.db.insert("signature_events", { id: id(), workspace_id: ctx.ws, envelope_id: eid, signer_id: s.id, type: "reminded", at: now(), ip: ctx.ip, meta: {} }); }
  tlog(ctx, String(e.contract_id), "signature", `Recordatorio enviado a ${pending.length} firmantes`);
  return pending.length;
}
export function cancelEnvelope(ctx: Ctx, eid: string, reason: string) {
  const e = ctx.db.get<Row>("SELECT * FROM signature_envelopes WHERE id=? AND workspace_id=?", eid, ctx.ws); if (!e) throw notFound("Sobre");
  if (!["sent", "in_progress"].includes(String(e.status))) throw conflict("El sobre no está en curso");
  ctx.db.update("signature_envelopes", eid, { status: "cancelled" });
  ctx.db.run("UPDATE signers SET status='cancelled' WHERE envelope_id=? AND status='pending'", eid);
  setStatus(ctx, String(e.contract_id), "APPROVED", `Sobre cancelado: ${reason}`);
}
/** Flujo público del firmante (token). */
export function signerView(ctx: Ctx, tk: string): Record<string, unknown> {
  const s = ctx.db.get<Row>("SELECT * FROM signers WHERE token=?", tk); if (!s) throw notFound("Enlace de firma");
  const e = ctx.db.get<Row>("SELECT * FROM signature_envelopes WHERE id=?", s.envelope_id) as Row;
  const c = ctx.db.get<Row>("SELECT number, title, counterparty_company_id FROM contracts WHERE id=?", e.contract_id) as Row;
  const v = ctx.db.get<Row>("SELECT body, sha256 FROM contract_versions WHERE id=?", e.version_id) as Row;
  const expired = String(e.expires_at) < now() && e.status !== "completed";
  if (!s.viewed_at && s.status === "pending") { ctx.db.update("signers", String(s.id), { viewed_at: now() }); ctx.db.insert("signature_events", { id: id(), workspace_id: e.workspace_id, envelope_id: e.id, signer_id: s.id, type: "viewed", at: now(), ip: ctx.ip, meta: {} }); }
  const others = ctx.db.all<Row>("SELECT name, party, status, order_no FROM signers WHERE envelope_id=? ORDER BY order_no", e.id);
  const turn = others.filter((o) => o.status === "pending").sort((a, b) => Number(a.order_no) - Number(b.order_no))[0];
  return { signer: { id: s.id, name: s.name, email: s.email, party: s.party, role: s.role, status: s.status, title: s.title, otp_sent: !!s.otp_sent_at, signed_at: s.signed_at }, envelope: { id: e.id, status: expired ? "expired" : e.status, level: e.level, expires_at: e.expires_at, message: e.message }, contract: { number: c.number, title: c.title }, company: ctx.settings.company_name, document: v.body, sha256: v.sha256, signers: others, my_turn: !turn || turn.name === s.name || true };
}
export function signerSendOtp(ctx: Ctx, tk: string): { sent_to: string; demo_code?: string } {
  const s = ctx.db.get<Row>("SELECT * FROM signers WHERE token=?", tk); if (!s) throw notFound("Enlace de firma");
  if (s.status !== "pending") throw conflict("Este firmante ya ha completado el proceso");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  ctx.db.update("signers", String(s.id), { otp_code: code, otp_sent_at: now(), otp_attempts: 0 });
  ctx.db.insert("signature_events", { id: id(), workspace_id: s.workspace_id, envelope_id: s.envelope_id, signer_id: s.id, type: "otp_sent", at: now(), ip: ctx.ip, meta: {} });
  void sendMail(ctx.db, String(s.workspace_id), { to: String(s.email), subject: "Tu código de firma", html: `<p>Código de verificación para firmar: <b style="font-size:22px">${code}</b> (válido 10 minutos).</p>`, track: false });
  return { sent_to: String(s.email).replace(/^(.{2}).*(@.*)$/, "$1***$2"), demo_code: process.env.NODE_ENV === "production" ? undefined : code };
}
export function signerSign(ctx: Ctx, tk: string, input: { otp: string; consent: boolean; name?: string; user_agent?: string }): { completed: boolean } {
  const s = ctx.db.get<Row>("SELECT * FROM signers WHERE token=?", tk); if (!s) throw notFound("Enlace de firma");
  const e = ctx.db.get<Row>("SELECT * FROM signature_envelopes WHERE id=?", s.envelope_id) as Row;
  if (e.status === "cancelled" || e.status === "expired") throw conflict("El sobre ya no está activo");
  if (String(e.expires_at) < now()) { ctx.db.update("signature_envelopes", String(e.id), { status: "expired" }); throw conflict("El enlace de firma ha caducado"); }
  if (s.status !== "pending") throw conflict("Ya has firmado este documento");
  if (!input.consent) throw badRequest("Debes aceptar el consentimiento de firma electrónica");
  if (!s.otp_code || !s.otp_sent_at) throw badRequest("Solicita primero el código de verificación");
  if (new Date(String(s.otp_sent_at)).getTime() < Date.now() - 10 * 60000) throw badRequest("El código ha caducado, solicita uno nuevo");
  if (Number(s.otp_attempts) >= 3) throw conflict("Demasiados intentos: solicita un nuevo código");
  if (String(input.otp).trim() !== s.otp_code) { ctx.db.update("signers", String(s.id), { otp_attempts: Number(s.otp_attempts) + 1 }); throw badRequest("Código incorrecto"); }
  const sysCtx = { ...ctx, ws: String(s.workspace_id) } as Ctx;
  ctx.db.insert("signature_events", { id: id(), workspace_id: s.workspace_id, envelope_id: e.id, signer_id: s.id, type: "otp_verified", at: now(), ip: ctx.ip, meta: {} });
  ctx.db.update("signers", String(s.id), { status: "signed", signed_at: now(), ip: ctx.ip, user_agent: input.user_agent ?? null, otp_code: null, consent_text: "Acepto firmar electrónicamente este documento y he leído su contenido íntegro.", name: input.name?.trim() || s.name });
  ctx.db.insert("signature_events", { id: id(), workspace_id: s.workspace_id, envelope_id: e.id, signer_id: s.id, type: "signed", at: now(), ip: ctx.ip, meta: { document_sha256: e.version_sha256 } });
  const c = ctx.db.get<Row>("SELECT * FROM contracts WHERE id=?", e.contract_id) as Row;
  tlog(sysCtx, String(c.id), "signature", `${s.name} ha firmado (${s.party === "us" ? "nosotros" : "contraparte"})`, null, { signer_id: s.id }, "external", String(s.name));
  const pending = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM signers WHERE envelope_id=? AND status='pending' AND role='signer'", e.id)?.n ?? 0;
  if (pending > 0) { if (c.status === "OUT_FOR_SIGNATURE") setStatus(sysCtx, String(c.id), "PARTIALLY_SIGNED", `${s.name} ha firmado`, "external"); emit(sysCtx, { type: "signer.signed", object: "contract", record: getContractRaw(ctx, String(c.id)) }); return { completed: false }; }
  // todos firmaron: documento final + evidencias
  const signersAll = ctx.db.all<Row>("SELECT name, email, party, signed_at, ip, user_agent FROM signers WHERE envelope_id=? ORDER BY order_no", e.id);
  const v = ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", e.version_id) as Row;
  const evidencePage = `\n\n=========================== CERTIFICADO DE EVIDENCIAS ===========================\nDocumento: ${c.number} · SHA-256 ${v.sha256}\nNivel de firma: ${e.level} (eIDAS) · Sello de tiempo: ${now()}\n` + signersAll.map((x) => `- ${x.name} <${x.email}> (${x.party === "us" ? "parte propia" : "contraparte"}) firmó el ${x.signed_at} desde IP ${x.ip ?? "-"} · OTP verificado por email`).join("\n") + `\nConsentimiento explícito registrado · Copia enviada a todas las partes (LSSI art. 28)\n`;
  const finalBody = String(v.body) + evidencePage;
  const finalSha = sha256(finalBody);
  ctx.db.run("UPDATE contract_versions SET is_current=0 WHERE contract_id=?", c.id);
  const fvid = id();
  ctx.db.insert("contract_versions", { id: fvid, workspace_id: c.workspace_id, contract_id: c.id, label: `${v.major}.${Number(v.minor) + 1}`, major: v.major, minor: Number(v.minor) + 1, branch: "external", source: "signed", body: finalBody, file_name: `${c.number}-firmado.txt`, sha256: finalSha, author_id: null, comment: "Documento firmado con página de evidencias (PAdES-B-T simulado)", is_current: 1, is_final: 1, is_signed: 1, locked: 1, template_id: v.template_id, created_at: now() });
  ctx.db.update("signature_envelopes", String(e.id), { status: "completed", completed_at: now(), final_sha256: finalSha, evidence: { signers: signersAll, timestamp: now(), document_sha256: v.sha256, final_sha256: finalSha } });
  ctx.db.update("contracts", String(c.id), { current_version_id: fvid, signed_version_id: fvid });
  for (const x of signersAll) void sendMail(ctx.db, String(c.workspace_id), { to: String(x.email), subject: `Copia firmada: ${c.title} (${c.number})`, html: `<p>Todas las partes han firmado <b>${c.title}</b>. Adjuntamos copia del documento final (hash ${finalSha.slice(0, 16)}…).</p><pre style="white-space:pre-wrap;font:13px/1.4 monospace">${finalBody.slice(0, 4000)}</pre>`, track: false });
  activateContract(sysCtx, String(c.id), "external");
  return { completed: true };
}
export function signerDecline(ctx: Ctx, tk: string, reason: string) {
  const s = ctx.db.get<Row>("SELECT * FROM signers WHERE token=?", tk); if (!s) throw notFound("Enlace de firma");
  if (s.status !== "pending") throw conflict("Ya has completado el proceso");
  const e = ctx.db.get<Row>("SELECT * FROM signature_envelopes WHERE id=?", s.envelope_id) as Row;
  ctx.db.update("signers", String(s.id), { status: "declined", declined_reason: reason });
  ctx.db.update("signature_envelopes", String(e.id), { status: "declined" });
  ctx.db.insert("signature_events", { id: id(), workspace_id: s.workspace_id, envelope_id: e.id, signer_id: s.id, type: "declined", at: now(), ip: ctx.ip, meta: { reason } });
  const sysCtx = { ...ctx, ws: String(s.workspace_id) } as Ctx;
  setStatus(sysCtx, String(e.contract_id), "REJECTED", `${s.name} ha rechazado la firma: ${reason}`, "external");
  const c = ctx.db.get<Row>("SELECT owner_id, number FROM contracts WHERE id=?", e.contract_id) as Row;
  notify(ctx.db, String(s.workspace_id), c.owner_id as string, { type: "signature", title: `Firma rechazada: ${c.number}`, body: `${s.name}: ${reason}`, link: `/contratos/${e.contract_id}?tab=signature` });
}
const getContractRaw = (ctx: Ctx, cid: string): Row => parseJson(ctx.db.get<Row>("SELECT * FROM contracts WHERE id=?", cid) as Row, JC);

/* ======================= activación, hitos, obligaciones, pagos ======================= */
export function activateContract(ctx: Ctx, cid: string, actorType: "user" | "system" | "external" = "user") {
  const c = getContractRaw(ctx, cid);
  const patch: Record<string, unknown> = { signed_at: c.signed_at ?? now(), updated_at: now() };
  if (!c.effective_date) patch.effective_date = today();
  Object.assign(patch, computeDates({ ...c, ...patch }));
  const t = getType(ctx, String(c.type_id));
  patch.retention_until = addMonths(String(patch.end_date ?? patch.effective_date ?? today()), Number(t.retention_years) * 12);
  ctx.db.update("contracts", cid, patch);
  setStatus(ctx, cid, "ACTIVE", "Firmado por todas las partes", actorType);
  regenerateMilestones(ctx, cid);
  suggestObligations(ctx, cid);
  generatePaymentSchedule(ctx, cid);
  if (c.kind === "amendment" && c.parent_id) applyAmendment(ctx, cid);
  if (c.kind === "renewal" && c.parent_id) { setStatus(ctx, String(c.parent_id), "RENEWED", `Sustituido por ${c.number}`, "system"); ctx.db.run("UPDATE obligations SET status='na' WHERE contract_id=? AND status IN ('pending','in_progress') AND survives_termination=0", c.parent_id); }
  if (c.deal_id) { const d = ctx.db.get<Row>("SELECT * FROM deals WHERE id=?", c.deal_id); if (d) { ctx.db.insert("activities", { id: id(), workspace_id: ctx.ws, type: "system", subject: `Contrato ${c.number} firmado y activo`, body: null, occurred_at: now(), user_id: null, deal_id: d.id, company_id: d.company_id, contact_id: null, ticket_id: null, meta: { contract_id: cid }, created_at: now() }); } }
  const upd = getContract(ctx, cid);
  notify(ctx.db, ctx.ws, c.owner_id as string, { type: "contract", title: `Contrato activo: ${c.number}`, body: `${c.title} firmado por todas las partes`, link: `/contratos/${cid}` });
  emit(ctx, { type: "contract.activated", object: "contract", record: upd });
}
export function regenerateMilestones(ctx: Ctx, cid: string) {
  const c = getContractRaw(ctx, cid);
  ctx.db.run("DELETE FROM milestones WHERE contract_id=? AND computed=1 AND status='upcoming'", cid);
  const add = (type: string, label: string, date: string | null, offsets: number[]) => { if (!date) return; if (ctx.db.get("SELECT id FROM milestones WHERE contract_id=? AND type=? AND date=?", cid, type, date)) return; ctx.db.insert("milestones", { id: id(), workspace_id: ctx.ws, contract_id: cid, type, label, date, computed: 1, owner_id: c.owner_id, alert_offsets: offsets, alerted: [], status: date < today() ? "passed" : "upcoming", created_at: now() }); };
  add("start", "Inicio de vigencia", c.effective_date as string | null, [0]);
  add("end", "Fin de vigencia", c.end_date as string | null, c.notice_period_days ? [30, 7] : [90, 60, 30, 7]);
  add("notice_deadline", `Límite de preaviso (${c.notice_period_days} días)`, c.notice_deadline as string | null, [120, 90, 60, 30, 14, 7, 1, 0]);
  if (c.renewal_type !== "none") add("renewal", c.renewal_type === "auto" ? "Renovación automática" : "Renovación por acuerdo", c.next_renewal_date as string | null, [30]);
}
function suggestObligations(ctx: Ctx, cid: string) {
  const c = getContractRaw(ctx, cid);
  const t = getType(ctx, String(c.type_id));
  const exists = (title: string) => ctx.db.get("SELECT id FROM obligations WHERE contract_id=? AND title=?", cid, title);
  const mk = (o: Record<string, unknown>) => { if (exists(String(o.title))) return; ctx.db.insert("obligations", { id: id(), workspace_id: ctx.ws, contract_id: cid, description: null, obligor: "us", owner_id: c.owner_id, recurrence: "none", status: "pending", amount: null, currency: c.currency, penalty_rule: null, evidence_required: 0, survives_termination: 0, ai_extracted: 1, created_at: now(), updated_at: now(), ...o }); };
  const clauses = ctx.db.all<Row>("SELECT category, params FROM contract_clauses WHERE contract_id=? AND version_id=?", cid, c.current_version_id).map((r) => parseJson(r, ["params"]));
  const has = (cat: string) => clauses.find((x) => x.category === cat);
  const paying = t.direction === "expense";
  if (Number(c.total_value) > 0) mk({ title: paying ? "Pagar la contraprestación pactada" : "Cobrar la contraprestación pactada", type: "payment", obligor: paying ? "us" : "them", due_date: c.payment_model === "recurring" ? addD(String(c.effective_date), 30) : addD(String(c.effective_date), Number(c.payment_terms_days) || 30), recurrence: c.payment_model === "recurring" ? "monthly" : "none", amount: c.payment_model === "recurring" ? Math.round(Number(c.annual_value) / 12) : c.total_value, source_clause: "C01" });
  if (c.notice_deadline) mk({ title: "Decidir renovación y comunicar preaviso si procede", type: "renewal", obligor: "us", due_date: c.notice_deadline, source_clause: "B03" });
  const conf = has("F01"); if (conf) { const years = Number((conf.params as Row).years) || 5; mk({ title: `Mantener la confidencialidad (${years} años tras la terminación)`, type: "confidentiality", obligor: "us", due_date: c.end_date ? addMonths(String(c.end_date), years * 12) : null, survives_termination: 1, survival_until: c.end_date ? addMonths(String(c.end_date), years * 12) : null, source_clause: "F01" }); }
  if (has("D03")) mk({ title: paying ? "Recibir informe mensual de niveles de servicio" : "Enviar informe mensual de niveles de servicio", type: "report", obligor: paying ? "them" : "us", due_date: addD(String(c.effective_date), 35), recurrence: "monthly", source_clause: "D03" });
  if (has("E06")) mk({ title: "Acreditar póliza de seguro vigente", type: "insurance", obligor: paying ? "them" : "us", due_date: addMonths(String(c.effective_date), 12), recurrence: "yearly", evidence_required: 1, source_clause: "E06" });
  if (has("F02") && c.contains_personal_data) mk({ title: "Supresión o devolución de datos personales al finalizar", type: "compliance", obligor: paying ? "them" : "us", due_date: c.end_date ? addD(String(c.end_date), 30) : null, survives_termination: 1, survival_until: c.end_date ? addD(String(c.end_date), 30) : null, evidence_required: 1, source_clause: "F02" });
  if (has("C05")) mk({ title: "Revisión anual de precios según IPC", type: "price_review", obligor: "us", due_date: addMonths(String(c.effective_date), 12), recurrence: "yearly", source_clause: "C05" });
}
export function generatePaymentSchedule(ctx: Ctx, cid: string) {
  const c = getContractRaw(ctx, cid);
  if (ctx.db.get("SELECT id FROM payment_schedule WHERE contract_id=? LIMIT 1", cid)) return;
  const eff = String(c.effective_date ?? today()); const cur = String(c.currency);
  const ins = (label: string, due: string, amount: number, type: string) => ctx.db.insert("payment_schedule", { id: id(), workspace_id: ctx.ws, contract_id: cid, label, due_date: due, amount: Math.round(amount * 100) / 100, currency: cur, type, status: "planned", created_at: now() });
  const total = Number(c.total_value) || 0; if (!total) return;
  if (c.payment_model === "recurring") { const months = Number(c.term_months) || 12; const monthly = (Number(c.annual_value) || total) / 12; for (let i = 0; i < Math.min(months, 36); i++) ins(`Cuota ${i + 1}`, addD(addMonths(eff, i), Number(c.payment_terms_days) || 0), monthly, "recurring"); }
  else if (c.payment_model === "milestone") { [0.3, 0.4, 0.3].forEach((p, i) => ins(`Hito ${i + 1}`, addMonths(eff, i * Math.max(1, Math.round((Number(c.term_months) || 6) / 3))), total * p, "milestone")); }
  else if (c.payment_model === "usage") { for (let i = 0; i < 12; i++) ins(`Consumo estimado mes ${i + 1}`, addD(addMonths(eff, i + 1), Number(c.payment_terms_days) || 0), total / 12, "usage"); }
  else ins("Pago único", addD(eff, Number(c.payment_terms_days) || 30), total, "one_off");
}
export function createObligation(ctx: Ctx, cid: string, input: z.infer<typeof obligationSchema>): Row {
  assert(ctx, "contract", "update"); getContract(ctx, cid);
  const oid = id();
  ctx.db.insert("obligations", { id: oid, workspace_id: ctx.ws, contract_id: cid, title: input.title, description: input.description ?? null, type: input.type ?? "other", obligor: input.obligor ?? "us", owner_id: input.owner_id ?? ctx.user.id, due_date: input.due_date ?? null, recurrence: input.recurrence ?? "none", status: input.status ?? "pending", amount: input.amount ?? null, currency: input.currency ?? ctx.settings.currency, penalty_rule: input.penalty_rule ?? null, evidence_required: input.evidence_required ? 1 : 0, survives_termination: input.survives_termination ? 1 : 0, survival_until: input.survival_until ?? null, ai_extracted: 0, source_clause: input.source_clause ?? null, created_at: now(), updated_at: now() });
  tlog(ctx, cid, "obligation", `Obligación añadida: ${input.title}`);
  return ctx.db.get<Row>("SELECT * FROM obligations WHERE id=?", oid) as Row;
}
export function updateObligation(ctx: Ctx, oid: string, patch: Partial<z.infer<typeof obligationSchema>> & { evidence_note?: string | null; evidence_url?: string | null }): Row {
  assert(ctx, "contract", "update");
  const o = ctx.db.get<Row>("SELECT * FROM obligations WHERE id=? AND workspace_id=?", oid, ctx.ws); if (!o) throw notFound("Obligación");
  const data: Record<string, unknown> = { ...patch, updated_at: now() };
  if ("evidence_required" in data) data.evidence_required = data.evidence_required ? 1 : 0;
  if ("survives_termination" in data) data.survives_termination = data.survives_termination ? 1 : 0;
  if (patch.status === "fulfilled" && o.status !== "fulfilled") {
    if (o.evidence_required && !patch.evidence_note && !patch.evidence_url && !o.evidence_note) throw badRequest("Esta obligación exige evidencia (nota o enlace)");
    data.fulfilled_at = now();
    if (o.recurrence !== "none" && o.due_date) {
      const next = o.recurrence === "weekly" ? addD(String(o.due_date), 7) : o.recurrence === "monthly" ? addMonths(String(o.due_date), 1) : o.recurrence === "quarterly" ? addMonths(String(o.due_date), 3) : addMonths(String(o.due_date), 12);
      const c = getContractRaw(ctx, String(o.contract_id)); const limit = (o.survival_until as string) ?? (c.end_date as string | null);
      if (!limit || next <= limit) ctx.db.insert("obligations", { ...o, id: id(), due_date: next, status: "pending", fulfilled_at: null, breached_at: null, evidence_note: null, evidence_url: null, reminded_at: null, created_at: now(), updated_at: now() });
    }
    tlog(ctx, String(o.contract_id), "obligation", `Obligación cumplida: ${o.title}`, patch.evidence_note ?? null);
    emit(ctx, { type: "obligation.fulfilled", object: "contract", record: getContractRaw(ctx, String(o.contract_id)), meta: { obligation_id: oid } });
  }
  if (patch.status === "breached" && o.status !== "breached") data.breached_at = now();
  ctx.db.update("obligations", oid, data);
  return ctx.db.get<Row>("SELECT * FROM obligations WHERE id=?", oid) as Row;
}
export function createMilestone(ctx: Ctx, cid: string, input: z.infer<typeof milestoneSchema>): Row {
  assert(ctx, "contract", "update"); getContract(ctx, cid);
  const mid = id();
  ctx.db.insert("milestones", { id: mid, workspace_id: ctx.ws, contract_id: cid, type: input.type ?? "custom", label: input.label, date: input.date, computed: 0, owner_id: input.owner_id ?? ctx.user.id, alert_offsets: input.alert_offsets ?? [30, 7, 1], alerted: [], status: input.date < today() ? "passed" : "upcoming", created_at: now() });
  return parseJson(ctx.db.get<Row>("SELECT * FROM milestones WHERE id=?", mid) as Row, ["alert_offsets", "alerted"]);
}
export function actionMilestone(ctx: Ctx, mid: string, action: string) {
  const m = ctx.db.get<Row>("SELECT * FROM milestones WHERE id=? AND workspace_id=?", mid, ctx.ws); if (!m) throw notFound("Hito");
  ctx.db.update("milestones", mid, { status: "actioned", actioned_at: now(), action_taken: action });
  tlog(ctx, String(m.contract_id), "milestone", `Hito «${m.label}»: ${action}`);
  if (m.type === "notice_deadline") recordRenewalDecision(ctx, String(m.contract_id), action, null);
}
export function recordRenewalDecision(ctx: Ctx, cid: string, decision: string, reason: string | null) {
  ctx.db.insert("renewal_decisions", { id: id(), workspace_id: ctx.ws, contract_id: cid, decision, reason, decided_by: ctx.user.id, decided_at: now() });
  tlog(ctx, cid, "renewal", `Decisión de renovación: ${decision}`, reason);
}

/* ======================= enmiendas, renovación, terminación ======================= */
export const amendmentSchema = z.object({ type: z.enum(["amendment", "change_order", "extension", "price_update", "assignment", "novation", "side_letter"]).optional(), title: z.string().trim().optional(), changes: z.object({ end_date: z.string().nullable().optional(), total_value: z.number().optional(), annual_value: z.number().optional(), notice_period_days: z.number().int().optional(), renewal_type: z.enum(["none", "auto", "by_agreement"]).optional(), payment_terms_days: z.number().int().optional(), term_months: z.number().int().optional() }).optional(), clause_text: z.string().optional(), template_id: z.string().nullable().optional() });
function childNumber(ctx: Ctx, parent: Row, kind: "amendment" | "renewal" | "termination"): { number: string; seq: number } {
  const seq = (ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM contracts WHERE parent_id=? AND kind=?", parent.id, kind)?.n ?? 0) + 1;
  const suffix = kind === "amendment" ? "A" : kind === "renewal" ? "R" : "T";
  return { number: `${parent.number}-${suffix}${String(seq).padStart(2, "0")}`, seq };
}
function letterTemplate(ctx: Ctx, kind: string): Row | null { return ctx.db.get<Row>("SELECT * FROM clm_templates WHERE workspace_id=? AND kind=? AND status='approved' ORDER BY created_at LIMIT 1", ctx.ws, kind) ?? null; }
export function createAmendment(ctx: Ctx, parentId: string, input: z.infer<typeof amendmentSchema>): Row {
  assert(ctx, "contract", "create");
  const p = getContract(ctx, parentId);
  if (p.status !== "ACTIVE") throw conflict("Solo se enmiendan contratos activos");
  if (ctx.db.get("SELECT id FROM contracts WHERE parent_id=? AND kind='amendment' AND status NOT IN ('ACTIVE','CANCELLED','REJECTED','ARCHIVED') AND deleted_at IS NULL", parentId)) throw conflict("Ya hay una enmienda en curso");
  const { number, seq } = childNumber(ctx, p, "amendment");
  const cid = id(); const changes = input.changes ?? {};
  const eff = (p.effective_values as Record<string, unknown>) ?? {};
  const current = { end_date: eff.end_date ?? p.end_date, total_value: eff.total_value ?? p.total_value, annual_value: eff.annual_value ?? p.annual_value, notice_period_days: eff.notice_period_days ?? p.notice_period_days, renewal_type: eff.renewal_type ?? p.renewal_type, payment_terms_days: eff.payment_terms_days ?? p.payment_terms_days, term_months: eff.term_months ?? p.term_months };
  if (changes.end_date && changes.end_date < today()) throw badRequest("La nueva fecha de fin no puede ser anterior a hoy: usa una terminación");
  const row = { ...getContractRaw(ctx, parentId), id: cid, number, title: input.title ?? `${input.type === "extension" ? "Prórroga" : input.type === "price_update" ? "Actualización de precio" : "Enmienda"} nº ${seq} · ${p.title}`, status: "DRAFT", prev_status: null, substatus: null, kind: "amendment", parent_id: parentId, amendment_seq: seq, amendment_type: input.type ?? "amendment", signed_at: null, signed_version_id: null, current_version_id: null, requested_at: now(), effective_values: {}, intake: { changes, before: current }, created_by: ctx.user.id, created_at: now(), updated_at: now(), last_activity_at: now(), risk_override: null, termination_date: null, termination_cause: null, legal_hold: 0, legal_hold_reason: null, retention_until: null, renewals_done: 0, ...changes, source: "intake" } as Record<string, unknown>;
  for (const k of ["type_name", "type_code", "direction", "type_color", "min_signature_level", "counterparty_name", "counterparty_country", "counterparty_tax_id", "owner_name", "legal_owner_name", "deal_name", "parent_number", "parent_title"]) delete row[k];
  Object.assign(row, computeDates(row));
  ctx.db.insert("contracts", row);
  ctx.db.update("contracts", parentId, { substatus: "UNDER_AMENDMENT", updated_at: now() });
  const tpl = input.template_id ? ctx.db.get<Row>("SELECT * FROM clm_templates WHERE id=?", input.template_id) : letterTemplate(ctx, "amendment");
  const lines = Object.entries(changes).map(([k, v]) => `- ${FIELD_ES[k] ?? k}: ${fmtVal(k, current[k as keyof typeof current])} → ${fmtVal(k, v)}`).join("\n");
  const body = tpl ? renderContractTemplate(ctx, String(tpl.body), { ...templateContext(ctx, getContractRaw(ctx, cid)), amendment: { seq, type: input.type ?? "amendment", changes_text: lines || "(sin cambios de metadatos)", clause_text: input.clause_text ?? "", parent_number: p.number, parent_title: p.title, parent_signed: fmtDateLong(p.signed_at) } }).text : `ENMIENDA Nº ${seq} AL CONTRATO ${p.number}\n\n${lines}\n\n${input.clause_text ?? ""}`;
  createVersion(ctx, cid, { body: `BORRADOR · ${number} · no válido para firma\n\n` + body, source: "generated", comment: "Enmienda generada", template_id: (tpl?.id as string) ?? null });
  tlog(ctx, parentId, "amendment", `Enmienda ${number} iniciada`, lines);
  tlog(ctx, cid, "created", `Enmienda al contrato ${p.number}`, lines);
  audit(ctx, "contract", cid, "create", { number, parent: p.number });
  return getContract(ctx, cid);
}
const FIELD_ES: Record<string, string> = { end_date: "Fecha de fin", total_value: "Valor total", annual_value: "Valor anual", notice_period_days: "Preaviso (días)", renewal_type: "Renovación", payment_terms_days: "Plazo de pago (días)", term_months: "Duración (meses)" };
const fmtVal = (k: string, v: unknown) => (v == null ? "—" : k.includes("value") ? fmtMoney(v) : k === "end_date" ? fmtDateLong(v) : String(v));
function applyAmendment(ctx: Ctx, amendmentId: string) {
  const a = getContractRaw(ctx, amendmentId); const parentId = String(a.parent_id);
  const p = getContractRaw(ctx, parentId);
  const changes = ((a.intake as Record<string, unknown>)?.changes as Record<string, unknown>) ?? {};
  const eff = { ...((p.effective_values as Record<string, unknown>) ?? {}) };
  const history = (eff.__history as Record<string, unknown>[]) ?? [];
  for (const [k, v] of Object.entries(changes)) { history.push({ field: k, from: eff[k] ?? p[k], to: v, since: a.effective_date ?? today(), source: a.number }); eff[k] = v; }
  eff.__history = history;
  const patch: Record<string, unknown> = { effective_values: eff, substatus: null, updated_at: now(), ...changes };
  Object.assign(patch, computeDates({ ...p, ...changes }));
  ctx.db.update("contracts", parentId, patch);
  regenerateMilestones(ctx, parentId);
  ctx.db.run("DELETE FROM payment_schedule WHERE contract_id=? AND status='planned' AND due_date>=?", parentId, today());
  tlog(ctx, parentId, "amendment", `Enmienda ${a.number} activa: valores vigentes actualizados`, Object.keys(changes).map((k) => FIELD_ES[k] ?? k).join(", "), {}, "system");
  emit(ctx, { type: "contract.amendment_activated", object: "contract", record: getContract(ctx, parentId) });
}
export function createRenewal(ctx: Ctx, parentId: string, input: { term_months?: number; total_value?: number; annual_value?: number; notice_period_days?: number; template_id?: string | null; title?: string }): Row {
  assert(ctx, "contract", "create");
  const p = getContract(ctx, parentId);
  if (!["ACTIVE", "EXPIRED"].includes(String(p.status))) throw conflict("Solo se renuevan contratos activos o vencidos");
  const { number, seq } = childNumber(ctx, p, "renewal");
  const cid = id();
  const start = p.end_date ? addD(String(p.end_date), 1) : today();
  const row = { ...getContractRaw(ctx, parentId), id: cid, number, title: input.title ?? `Renovación ${seq} · ${p.title}`, status: "DRAFT", prev_status: null, substatus: null, kind: "renewal", parent_id: parentId, amendment_seq: seq, amendment_type: null, signed_at: null, signed_version_id: null, current_version_id: null, requested_at: now(), effective_date: start, end_date: null, term_months: input.term_months ?? p.term_months ?? 12, total_value: input.total_value ?? p.total_value, annual_value: input.annual_value ?? p.annual_value, notice_period_days: input.notice_period_days ?? p.notice_period_days, effective_values: {}, intake: { renewal_of: p.number }, created_by: ctx.user.id, created_at: now(), updated_at: now(), last_activity_at: now(), risk_override: null, termination_date: null, termination_cause: null, legal_hold: 0, legal_hold_reason: null, retention_until: null, renewals_done: 0, source: "intake" } as Record<string, unknown>;
  for (const k of ["type_name", "type_code", "direction", "type_color", "min_signature_level", "counterparty_name", "counterparty_country", "counterparty_tax_id", "owner_name", "legal_owner_name", "deal_name", "parent_number", "parent_title"]) delete row[k];
  Object.assign(row, computeDates(row));
  ctx.db.insert("contracts", row);
  const t = getType(ctx, String(p.type_id));
  const tplId = input.template_id ?? (t.default_template_id as string | null) ?? (ctx.db.get<Row>("SELECT template_id FROM contract_versions WHERE contract_id=? AND template_id IS NOT NULL ORDER BY created_at LIMIT 1", parentId)?.template_id as string | null);
  if (tplId) generateFromTemplate(ctx, cid, tplId, { comment: `Renovación generada a partir de ${p.number}` });
  else { const v = ctx.db.get<Row>("SELECT body FROM contract_versions WHERE id=?", p.signed_version_id ?? p.current_version_id); if (v) createVersion(ctx, cid, { body: `BORRADOR · ${number} · renovación de ${p.number}\n\n` + String(v.body).replace(/\n=+ CERTIFICADO DE EVIDENCIAS[\s\S]*$/, ""), source: "generated", comment: "Copia del contrato anterior para renovación" }); }
  recordRenewalDecision(ctx, parentId, "renegotiate", `Renovación ${number} abierta`);
  tlog(ctx, parentId, "renewal", `Renovación ${number} iniciada`);
  audit(ctx, "contract", cid, "create", { number, renewal_of: p.number });
  return getContract(ctx, cid);
}
export function terminateContract(ctx: Ctx, cid: string, input: { cause?: string; date?: string; note?: string; cost?: number }): Row {
  const c = getContract(ctx, cid);
  if (c.status !== "ACTIVE") throw conflict("Solo se terminan contratos activos");
  const cause = input.cause ?? "convenience"; const date = input.date ?? today();
  if (cause === "convenience" && c.notice_period_days && date < addD(today(), Number(c.notice_period_days)) && !input.note) throw badRequest(`La terminación por conveniencia exige ${c.notice_period_days} días de preaviso: elige una fecha posterior o justifica en la nota`);
  if (cause === "breach" && !input.note) throw badRequest("Terminación por incumplimiento: registra el requerimiento previo y el plazo de subsanación en la nota");
  const tpl = letterTemplate(ctx, "termination");
  const text = tpl ? renderContractTemplate(ctx, String(tpl.body), { ...templateContext(ctx, c), termination: { cause: TERMINATION_ES[cause] ?? cause, date: fmtDateLong(date), note: input.note ?? "" } }).text : `CARTA DE TERMINACIÓN del contrato ${c.number} con efectos ${fmtDateLong(date)} por ${TERMINATION_ES[cause] ?? cause}.\n${input.note ?? ""}`;
  const vid = id();
  ctx.db.insert("contract_versions", { id: vid, workspace_id: ctx.ws, contract_id: cid, label: "T", major: 99, minor: 0, branch: "external", source: "generated", body: text, file_name: `${c.number}-terminacion.txt`, sha256: sha256(text), author_id: ctx.user.id, comment: "Carta de terminación", is_current: 0, is_final: 1, locked: 1, created_at: now() });
  const t = getType(ctx, String(c.type_id));
  ctx.db.update("contracts", cid, { termination_date: date, termination_cause: cause, retention_until: addMonths(date, Number(t.retention_years) * 12), updated_at: now() });
  ctx.db.run("UPDATE obligations SET status='na', updated_at=? WHERE contract_id=? AND status IN ('pending','in_progress') AND survives_termination=0", now(), cid);
  ctx.db.run("UPDATE milestones SET status='passed' WHERE contract_id=? AND status='upcoming' AND type IN ('end','notice_deadline','renewal')", cid);
  ctx.db.run("DELETE FROM payment_schedule WHERE contract_id=? AND status='planned' AND due_date>?", cid, date);
  setStatus(ctx, cid, "TERMINATED", `${TERMINATION_ES[cause] ?? cause} · efectos ${date}`);
  const exit = ["Devolución o destrucción de datos y materiales", "Retirada de accesos y notificación a IT", "Liquidación de pagos pendientes"];
  exit.forEach((e, i) => ctx.db.insert("obligations", { id: id(), workspace_id: ctx.ws, contract_id: cid, title: e, description: "Obligación de salida generada al terminar", type: i === 0 ? "return" : i === 1 ? "compliance" : "payment", obligor: "us", owner_id: c.owner_id, due_date: addD(date, 15), recurrence: "none", status: "pending", currency: c.currency, evidence_required: i === 0 ? 1 : 0, survives_termination: 1, survival_until: addD(date, 15), ai_extracted: 0, created_at: now(), updated_at: now() }));
  const contact = c.counterparty_company_id ? ctx.db.get<{ email: string }>("SELECT email FROM contacts WHERE company_id=? AND email IS NOT NULL AND deleted_at IS NULL LIMIT 1", c.counterparty_company_id)?.email : null;
  if (contact) void sendMail(ctx.db, ctx.ws, { to: contact, subject: `Comunicación de terminación del contrato ${c.number}`, html: `<pre style="white-space:pre-wrap">${text}</pre>`, track: false });
  emit(ctx, { type: "contract.terminated", object: "contract", record: getContract(ctx, cid) });
  return getContract(ctx, cid);
}
const TERMINATION_ES: Record<string, string> = { expiry: "vencimiento natural", mutual: "mutuo acuerdo", convenience: "conveniencia", breach: "incumplimiento", insolvency: "insolvencia", change_of_control: "cambio de control", force_majeure: "fuerza mayor", nullity: "nulidad" };

/* ======================= comparación de versiones ======================= */
export function compareVersions(a: string, b: string): { html: string; summary: { added: number; removed: number; modified: number; pct: number }; paragraphs: { type: "same" | "added" | "removed" | "modified"; a?: string; b?: string; words?: { type: "same" | "add" | "del"; text: string }[] }[] } {
  const pa = a.split(/\n+/).map((s) => s.trim()).filter(Boolean), pb = b.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const sim = (x: string, y: string) => { const wx = new Set(x.toLowerCase().split(/\W+/).filter(Boolean)), wy = new Set(y.toLowerCase().split(/\W+/).filter(Boolean)); let inter = 0; wx.forEach((w) => { if (wy.has(w)) inter++; }); return inter / Math.max(1, Math.max(wx.size, wy.size)); };
  // LCS sobre párrafos con similitud >= 0.6 como "iguales/modificados"
  const n = pa.length, m = pb.length; const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = sim(pa[i]!, pb[j]!) >= 0.6 ? 1 + L[i + 1]![j + 1]! : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: ReturnType<typeof compareVersions>["paragraphs"] = []; let i = 0, j = 0;
  const wordDiff = (x: string, y: string) => { const wx = x.split(/(\s+)/), wy = y.split(/(\s+)/); const n2 = wx.length, m2 = wy.length; const D: number[][] = Array.from({ length: n2 + 1 }, () => new Array<number>(m2 + 1).fill(0)); for (let p = n2 - 1; p >= 0; p--) for (let q = m2 - 1; q >= 0; q--) D[p]![q] = wx[p] === wy[q] ? 1 + D[p + 1]![q + 1]! : Math.max(D[p + 1]![q]!, D[p]![q + 1]!); const w: { type: "same" | "add" | "del"; text: string }[] = []; let p = 0, q = 0; while (p < n2 && q < m2) { if (wx[p] === wy[q]) { w.push({ type: "same", text: wx[p]! }); p++; q++; } else if (D[p + 1]![q]! >= D[p]![q + 1]!) { w.push({ type: "del", text: wx[p]! }); p++; } else { w.push({ type: "add", text: wy[q]! }); q++; } } while (p < n2) w.push({ type: "del", text: wx[p++]! }); while (q < m2) w.push({ type: "add", text: wy[q++]! }); return w; };
  while (i < n && j < m) { if (sim(pa[i]!, pb[j]!) >= 0.6) { if (pa[i] === pb[j]) out.push({ type: "same", a: pa[i], b: pb[j] }); else out.push({ type: "modified", a: pa[i], b: pb[j], words: wordDiff(pa[i]!, pb[j]!) }); i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) { out.push({ type: "removed", a: pa[i] }); i++; } else { out.push({ type: "added", b: pb[j] }); j++; } }
  while (i < n) out.push({ type: "removed", a: pa[i++] }); while (j < m) out.push({ type: "added", b: pb[j++] });
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const html = out.map((p) => p.type === "same" ? `<p>${esc(p.a!)}</p>` : p.type === "added" ? `<p class="ins">${esc(p.b!)}</p>` : p.type === "removed" ? `<p class="del">${esc(p.a!)}</p>` : `<p>${p.words!.map((w) => (w.type === "same" ? esc(w.text) : w.type === "add" ? `<ins>${esc(w.text)}</ins>` : `<del>${esc(w.text)}</del>`)).join("")}</p>`).join("");
  const added = out.filter((p) => p.type === "added").length, removed = out.filter((p) => p.type === "removed").length, modified = out.filter((p) => p.type === "modified").length;
  return { html, summary: { added, removed, modified, pct: Math.round((100 * (added + removed + modified)) / Math.max(1, out.length)) }, paragraphs: out };
}

/* ======================= trabajos diarios ======================= */
export function dailyContractChecks(ctx: Ctx) {
  const td = today();
  const sysNotify = (uid: string | null | undefined, title: string, body: string, link: string) => notify(ctx.db, ctx.ws, uid, { type: "contract", title, body, link });
  // 1. alertas de hitos por escalonado
  for (const m of ctx.db.all<Row>("SELECT m.*, c.owner_id AS c_owner, c.legal_owner_id, c.number, c.title, c.status AS cstatus FROM milestones m JOIN contracts c ON c.id=m.contract_id WHERE m.workspace_id=? AND m.status='upcoming' AND c.deleted_at IS NULL AND c.status='ACTIVE'", ctx.ws).map((r) => parseJson(r, ["alert_offsets", "alerted"]))) {
    const offsets = (m.alert_offsets as number[]) ?? []; const alerted = (m.alerted as number[]) ?? []; const daysLeft = Math.round((new Date(String(m.date) + "T00:00:00Z").getTime() - new Date(td + "T00:00:00Z").getTime()) / 864e5);
    const due = offsets.filter((o) => !alerted.includes(o) && daysLeft <= o);
    if (!due.length) continue;
    const level = due.some((o) => o <= 7) ? 3 : due.some((o) => o <= 30) ? 2 : 1;
    const title = `${m.label}: ${m.number} ${daysLeft >= 0 ? `en ${daysLeft} días` : `hace ${-daysLeft} días`}`;
    sysNotify(m.owner_id as string, title, String(m.title), `/contratos/${m.contract_id}?tab=milestones`);
    if (level >= 2 && m.legal_owner_id && m.legal_owner_id !== m.owner_id) sysNotify(m.legal_owner_id as string, title, String(m.title), `/contratos/${m.contract_id}?tab=milestones`);
    if (level >= 3) { const mgr = managerOf(ctx, m.owner_id as string); if (mgr && mgr !== m.owner_id) sysNotify(mgr, `Escalado · ${title}`, String(m.title), `/contratos/${m.contract_id}?tab=milestones`); }
    ctx.db.update("milestones", String(m.id), { alerted: [...alerted, ...due], status: daysLeft >= 0 ? "alerted" : "upcoming" });
    emit(ctx, { type: "milestone.approaching", object: "contract", record: getContractRaw(ctx, String(m.contract_id)), meta: { milestone: m.type, days: daysLeft } });
    if (m.type === "notice_deadline" && daysLeft <= 120 && !ctx.db.get("SELECT id FROM tasks WHERE workspace_id=? AND title LIKE ? AND completed_at IS NULL", ctx.ws, `Expediente de renovación ${m.number}%`)) {
      ctx.db.insert("tasks", { id: id(), workspace_id: ctx.ws, title: `Expediente de renovación ${m.number}: decidir renovar / renegociar / no renovar`, type: "todo", due_at: addDays(String(m.date) + "T09:00:00.000Z", -15), priority: "high", assignee_id: m.owner_id, company_id: ctx.db.get<Row>("SELECT counterparty_company_id FROM contracts WHERE id=?", m.contract_id)?.counterparty_company_id ?? null, created_by: null, created_at: now(), updated_at: now() });
      tlog(ctx, String(m.contract_id), "renewal", "Expediente de renovación abierto automáticamente (T-120)", null, {}, "agent", "Agente de renovación");
    }
  }
  // 2. preaviso vencido sin decisión -> renovación automática por inacción o vencimiento
  for (const c of ctx.db.all<Row>("SELECT * FROM contracts WHERE workspace_id=? AND status='ACTIVE' AND deleted_at IS NULL AND end_date IS NOT NULL AND end_date < ?", ctx.ws, td)) {
    const decided = ctx.db.get<Row>("SELECT decision FROM renewal_decisions WHERE contract_id=? ORDER BY decided_at DESC LIMIT 1", c.id);
    const renewalOpen = ctx.db.get("SELECT id FROM contracts WHERE parent_id=? AND kind='renewal' AND status NOT IN ('CANCELLED','REJECTED') AND deleted_at IS NULL", c.id);
    if (c.renewal_type === "auto" && decided?.decision !== "not_renew" && (!c.max_renewals || Number(c.renewals_done) < Number(c.max_renewals))) {
      const period = Number(c.renewal_period_months) || Number(c.term_months) || 12;
      const newEnd = addMonths(String(c.end_date), period);
      const patch: Record<string, unknown> = { end_date: newEnd, renewals_done: Number(c.renewals_done) + 1, updated_at: now() }; Object.assign(patch, computeDates({ ...c, ...patch, end_date: newEnd }));
      ctx.db.update("contracts", String(c.id), patch);
      regenerateMilestones(ctx, String(c.id));
      ctx.db.insert("renewal_decisions", { id: id(), workspace_id: ctx.ws, contract_id: c.id, decision: decided?.decision === "renew" ? "renew" : "auto_renewed_by_inaction", reason: decided ? null : "Se alcanzó el fin sin decisión registrada", decided_by: null, decided_at: now() });
      tlog(ctx, String(c.id), "renewal", decided?.decision === "renew" ? `Renovado hasta ${newEnd}` : `SE HA RENOVADO AUTOMÁTICAMENTE por inacción hasta ${newEnd}`, null, {}, "system");
      if (!decided) { sysNotify(c.owner_id as string, `Renovación automática por inacción: ${c.number}`, `Nuevo fin ${newEnd}. Revisa el contrato.`, `/contratos/${c.id}`); const mgr = managerOf(ctx, c.owner_id as string); if (mgr) sysNotify(mgr, `Escalado · renovación automática ${c.number}`, `Sin decisión antes del preaviso`, `/contratos/${c.id}`); ctx.db.insert("tasks", { id: id(), workspace_id: ctx.ws, title: `Revisar renovación automática por inacción: ${c.number}`, type: "todo", due_at: addDays(now(), 3), priority: "high", assignee_id: c.owner_id, company_id: c.counterparty_company_id, created_by: null, created_at: now(), updated_at: now() }); }
      emit(ctx, { type: "contract.auto_renewed", object: "contract", record: getContractRaw(ctx, String(c.id)) });
    } else if (!renewalOpen) {
      setStatus(ctx, String(c.id), "EXPIRED", "Fecha de fin alcanzada", "system");
      ctx.db.run("UPDATE obligations SET status='na', updated_at=? WHERE contract_id=? AND status IN ('pending','in_progress') AND survives_termination=0", now(), c.id);
      sysNotify(c.owner_id as string, `Contrato vencido: ${c.number}`, String(c.title), `/contratos/${c.id}`);
      emit(ctx, { type: "contract.expired", object: "contract", record: getContractRaw(ctx, String(c.id)) });
    }
  }
  // 3. obligaciones: recordatorios T-7 e incumplimientos
  for (const o of ctx.db.all<Row>("SELECT o.*, c.number FROM obligations o JOIN contracts c ON c.id=o.contract_id WHERE o.workspace_id=? AND o.status IN ('pending','in_progress') AND o.due_date IS NOT NULL", ctx.ws)) {
    if (String(o.due_date) < td) { ctx.db.update("obligations", String(o.id), { status: "breached", breached_at: now(), updated_at: now() }); emit(ctx, { type: "obligation.breached", object: "contract", record: getContractRaw(ctx, String(o.contract_id)), meta: { obligation_id: o.id, obligation: o.title } }); sysNotify(o.owner_id as string, `Obligación incumplida: ${o.title}`, `${o.number} · vencía el ${o.due_date}`, `/contratos/${o.contract_id}?tab=obligations`); const mgr = managerOf(ctx, o.owner_id as string); if (mgr) sysNotify(mgr, `Escalado · obligación incumplida ${o.number}`, String(o.title), `/contratos/${o.contract_id}?tab=obligations`); tlog(ctx, String(o.contract_id), "obligation", `Obligación incumplida: ${o.title}`, null, {}, "system"); emit(ctx, { type: "obligation.breached", object: "contract", record: getContractRaw(ctx, String(o.contract_id)), meta: { obligation_id: o.id } }); }
    else if (!o.reminded_at && String(o.due_date) <= addD(td, 7)) { ctx.db.update("obligations", String(o.id), { reminded_at: now() }); sysNotify(o.owner_id as string, `Obligación próxima: ${o.title}`, `${o.number} · vence el ${o.due_date}`, `/contratos/${o.contract_id}?tab=obligations`); }
  }
  // 4. pagos vencidos
  ctx.db.run("UPDATE payment_schedule SET status='overdue' WHERE workspace_id=? AND status='planned' AND due_date < ?", ctx.ws, td);
  // 5. sobres caducados y recordatorios (3, 7, 14 días)
  for (const e of ctx.db.all<Row>("SELECT * FROM signature_envelopes WHERE workspace_id=? AND status IN ('sent','in_progress')", ctx.ws)) {
    if (String(e.expires_at) < now()) { ctx.db.update("signature_envelopes", String(e.id), { status: "expired" }); setStatus(ctx, String(e.contract_id), "APPROVED", "El sobre de firma ha caducado: vuelve a enviarlo", "system"); continue; }
    const days = Math.floor((Date.now() - new Date(String(e.sent_at)).getTime()) / 864e5);
    if ([3, 7, 14].includes(days)) { const ev = (e.evidence as Record<string, unknown>) ?? {}; const sent = (ev.reminders as number[]) ?? []; if (!sent.includes(days)) { const pending = ctx.db.all<Row>("SELECT * FROM signers WHERE envelope_id=? AND status='pending'", e.id); const c = ctx.db.get<Row>("SELECT title FROM contracts WHERE id=?", e.contract_id) as Row; for (const s of pending) void sendMail(ctx.db, ctx.ws, { to: String(s.email), subject: `Recordatorio de firma: ${c.title}`, html: `<p>Tienes pendiente firmar <b>${c.title}</b>: <a href="/s/${s.token}">firmar ahora</a>.</p>`, track: false }); ctx.db.update("signature_envelopes", String(e.id), { evidence: { ...ev, reminders: [...sent, days] } }); } }
  }
  // 6. aprobaciones vencidas: escalar al manager del aprobador
  for (const a of ctx.db.all<Row>("SELECT a.*, c.number FROM contract_approvals a JOIN contracts c ON c.id=a.contract_id WHERE a.workspace_id=? AND a.status='pending' AND a.due_at < ? AND a.escalated_at IS NULL", ctx.ws, now())) {
    const mgr = managerOf(ctx, a.approver_user_id as string);
    ctx.db.update("contract_approvals", String(a.id), { escalated_at: now() });
    sysNotify(a.approver_user_id as string, `Aprobación vencida: ${a.number}`, String(a.step_name), `/contratos/${a.contract_id}?tab=approvals`);
    if (mgr) sysNotify(mgr, `Escalado · aprobación sin respuesta ${a.number}`, `${a.step_name} · ${userName(ctx, a.approver_user_id as string)}`, `/contratos/${a.contract_id}?tab=approvals`);
    emit(ctx, { type: "approval.overdue", object: "contract", record: getContractRaw(ctx, String(a.contract_id)) });
  }
  // 7. cola de legal: SLA vencido
  for (const c of ctx.db.all<Row>("SELECT * FROM contracts WHERE workspace_id=? AND status IN ('INTERNAL_REVIEW','PENDING_APPROVAL') AND sla_paused=0 AND sla_due_at < ? AND deleted_at IS NULL AND substatus IS NULL", ctx.ws, now())) { ctx.db.update("contracts", String(c.id), { substatus: "SLA_BREACHED" }); sysNotify(c.legal_owner_id as string, `SLA de legal vencido: ${c.number}`, String(c.title), `/contratos/${c.id}`); }
}

/* ======================= listados, detalle, informes ======================= */
export function listContracts(ctx: Ctx, q: ListQuery, extra: { type_id?: string; status?: string; family?: string; queue?: string; kind?: string; counterparty?: string } = {}) {
  assert(ctx, "contract", "read");
  const where: string[] = []; const params: unknown[] = [];
  if (extra.type_id) { where.push("t.type_id=?"); params.push(extra.type_id); }
  if (extra.status) { const st = extra.status.split(","); where.push(`t.status IN (${st.map(() => "?").join(",")})`); params.push(...st); }
  if (extra.kind) { where.push("t.kind=?"); params.push(extra.kind); }
  if (extra.counterparty) { where.push("t.counterparty_company_id=?"); params.push(extra.counterparty); }
  if (extra.family) { where.push("ct.family=?"); params.push(extra.family); }
  if (extra.queue === "legal") { where.push("t.status IN ('INTERNAL_REVIEW','NEGOTIATION','PENDING_APPROVAL')"); }
  if (extra.queue === "expiring") { where.push("t.status='ACTIVE' AND (t.notice_deadline <= ? OR t.end_date <= ?)"); params.push(addD(today(), 180), addD(today(), 180)); }
  if (extra.queue === "mine") { where.push("(t.owner_id=? OR t.legal_owner_id=?)"); params.push(ctx.user.id, ctx.user.id); }
  return listRecords<Row>(ctx, "contract", q, {
    where: where.length ? where.join(" AND ") : undefined, params,
    joins: "JOIN contract_types ct ON ct.id=t.type_id",
    select: "ct.name AS type_name, ct.code AS type_code, ct.direction, ct.color AS type_color, (SELECT name FROM companies WHERE id=t.counterparty_company_id) AS counterparty_name, (SELECT name FROM users WHERE id=t.owner_id) AS owner_name, (SELECT name FROM users WHERE id=t.legal_owner_id) AS legal_owner_name, (SELECT COUNT(*) FROM obligations o WHERE o.contract_id=t.id AND o.status IN ('pending','in_progress')) AS open_obligations, (SELECT COUNT(*) FROM obligations o WHERE o.contract_id=t.id AND o.status='breached') AS breached_obligations, (SELECT COUNT(*) FROM contract_clauses cc WHERE cc.contract_id=t.id AND cc.version_id=t.current_version_id AND cc.deviation_level IN ('minor','major','prohibited','missing')) AS deviations, (SELECT COUNT(*) FROM contract_approvals a WHERE a.contract_id=t.id AND a.status='pending') AS pending_approvals, (SELECT label FROM contract_versions v WHERE v.id=t.current_version_id) AS version_label, (SELECT COUNT(*) FROM contracts ch WHERE ch.parent_id=t.id AND ch.deleted_at IS NULL) AS children, CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_paused=0 AND t.status IN ('INTERNAL_REVIEW','PENDING_APPROVAL') THEN ROUND((julianday(t.sla_due_at)-julianday('now'))*24) ELSE NULL END AS sla_hours_left",
  });
}
export function contractDetail(ctx: Ctx, cid: string): Record<string, unknown> {
  const c = getContract(ctx, cid);
  const versions = ctx.db.all<Row>("SELECT v.id, v.label, v.major, v.minor, v.branch, v.source, v.file_name, v.sha256, v.comment, v.is_current, v.is_final, v.is_signed, v.locked, v.template_id, v.created_at, u.name AS author_name, length(v.body) AS size FROM contract_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.contract_id=? ORDER BY v.major, v.minor", cid);
  const current = c.current_version_id ? ctx.db.get<Row>("SELECT * FROM contract_versions WHERE id=?", c.current_version_id) : null;
  const clauses = ctx.db.all<Row>("SELECT cc.*, cl.title AS suggested_title, cl.code AS suggested_code, cl.body AS suggested_body FROM contract_clauses cc LEFT JOIN clauses cl ON cl.id=cc.suggested_clause_id WHERE cc.contract_id=? AND cc.version_id=? ORDER BY CASE cc.deviation_level WHEN 'prohibited' THEN 0 WHEN 'missing' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 ELSE 4 END, cc.position", cid, c.current_version_id).map((r) => parseJson(r, ["params"]));
  const approvals = ctx.db.all<Row>("SELECT a.*, u.name AS approver_name, d.name AS decided_by_name FROM contract_approvals a LEFT JOIN users u ON u.id=a.approver_user_id LEFT JOIN users d ON d.id=a.decided_by WHERE a.contract_id=? ORDER BY a.created_at, a.step_order", cid);
  const envelopes = ctx.db.all<Row>("SELECT * FROM signature_envelopes WHERE contract_id=? ORDER BY created_at DESC", cid).map((e) => ({ ...parseJson(e, ["evidence"]), signers: ctx.db.all<Row>("SELECT id, name, email, party, role, title, status, order_no, viewed_at, signed_at, ip, declined_reason, token FROM signers WHERE envelope_id=? ORDER BY order_no", e.id), events: ctx.db.all<Row>("SELECT e.*, s.name AS signer_name FROM signature_events e LEFT JOIN signers s ON s.id=e.signer_id WHERE e.envelope_id=? ORDER BY e.at", e.id).map((x) => parseJson(x, ["meta"])) }));
  const obligations = ctx.db.all<Row>("SELECT o.*, u.name AS owner_name FROM obligations o LEFT JOIN users u ON u.id=o.owner_id WHERE o.contract_id=? ORDER BY CASE o.status WHEN 'breached' THEN 0 WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 1 ELSE 2 END, o.due_date", cid);
  const milestones = ctx.db.all<Row>("SELECT * FROM milestones WHERE contract_id=? ORDER BY date", cid).map((m) => parseJson(m, ["alert_offsets", "alerted"]));
  const payments = ctx.db.all<Row>("SELECT * FROM payment_schedule WHERE contract_id=? ORDER BY due_date", cid);
  const children = ctx.db.all<Row>("SELECT id, number, title, kind, status, amendment_seq, amendment_type, effective_date, end_date, total_value, signed_at, created_at FROM contracts WHERE parent_id=? AND deleted_at IS NULL ORDER BY created_at", cid);
  const timeline = ctx.db.all<Row>("SELECT * FROM contract_timeline WHERE contract_id=? ORDER BY at DESC LIMIT 200", cid).map((r) => parseJson(r, ["meta"]));
  const comments = ctx.db.all<Row>("SELECT * FROM contract_comments WHERE contract_id=? ORDER BY created_at", cid);
  const renewals = ctx.db.all<Row>("SELECT r.*, u.name AS decided_by_name FROM renewal_decisions r LEFT JOIN users u ON u.id=r.decided_by WHERE r.contract_id=? ORDER BY r.decided_at DESC", cid);
  const audits = ctx.db.all<Row>("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.object='contract' AND a.record_id=? ORDER BY a.created_at DESC LIMIT 100", cid).map((r) => parseJson(r, ["changes"]));
  const pendingForMe = approvals.filter((a) => a.status === "pending" && a.approver_user_id === ctx.user.id);
  return { ...c, transitions: availableTransitions(c), versions, current_body: current?.body ?? "", clauses, approvals, envelopes, obligations, milestones, payments, children, timeline, comments, renewals, audits, pending_for_me: pendingForMe.length, approval_preview: ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION"].includes(String(c.status)) ? computeApprovalSteps(ctx, c) : [], checklist: c.status === "APPROVED" ? preSignatureChecklist(ctx, cid, []) : null };
}
export function clmReports(ctx: Ctx) {
  assert(ctx, "contract", "read");
  const scope = ownerScope(ctx, "c.owner_id");
  const rows = ctx.db.all<Row>(`SELECT c.*, t.direction, t.name AS type_name FROM contracts c JOIN contract_types t ON t.id=c.type_id WHERE c.workspace_id=? AND c.deleted_at IS NULL AND ${scope.sql}`, ctx.ws, ...scope.params);
  const active = rows.filter((r) => r.status === "ACTIVE");
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  const signed = rows.filter((r) => r.signed_at && r.requested_at).map((r) => (new Date(String(r.signed_at)).getTime() - new Date(String(r.requested_at)).getTime()) / 864e5).sort((a, b) => a - b);
  const median = signed.length ? signed[Math.floor(signed.length / 2)]! : 0; const p90 = signed.length ? signed[Math.min(signed.length - 1, Math.floor(signed.length * 0.9))]! : 0;
  const income = active.filter((r) => r.direction === "income").reduce((a, r) => a + Number(r.annual_value), 0), expense = active.filter((r) => r.direction === "expense").reduce((a, r) => a + Number(r.annual_value), 0);
  const in12 = active.filter((r) => r.end_date && String(r.end_date) <= addMonths(today(), 12));
  const byCp: Record<string, number> = {}; active.forEach((r) => { const k = String(r.counterparty_company_id ?? "?"); byCp[k] = (byCp[k] ?? 0) + Number(r.annual_value); });
  const top5 = Object.entries(byCp).sort((a, b) => b[1] - a[1]).slice(0, 5); const totalCp = Object.values(byCp).reduce((a, b) => a + b, 0);
  const risk = { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>; active.forEach((r) => { risk[String(r.risk_level)] = (risk[String(r.risk_level)] ?? 0) + 1; });
  const obl = (ctx.db.get<Row>("SELECT SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status='breached' THEN 1 ELSE 0 END) bad, SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) open FROM obligations WHERE workspace_id=?", ctx.ws) ?? {}) as Row;
  const autoRen = ctx.db.all<Row>("SELECT r.decided_at, c.number, c.title, c.annual_value FROM renewal_decisions r JOIN contracts c ON c.id=r.contract_id WHERE r.workspace_id=? AND r.decision='auto_renewed_by_inaction' ORDER BY r.decided_at DESC LIMIT 20", ctx.ws);
  const noDpa = rows.filter((r) => r.status === "ACTIVE" && r.contains_personal_data && r.data_role === "processor" && !ctx.db.get("SELECT id FROM contract_clauses WHERE contract_id=? AND version_id=? AND category='F02' AND status<>'missing'", r.id, r.current_version_id)).map((r) => ({ id: r.id, number: r.number, title: r.title }));
  const payGt60 = rows.filter((r) => Number(r.payment_terms_days) > 60 && ["ACTIVE", "DRAFT", "INTERNAL_REVIEW", "NEGOTIATION"].includes(String(r.status))).map((r) => ({ id: r.id, number: r.number, title: r.title, days: r.payment_terms_days }));
  const unlimited = ctx.db.all<Row>("SELECT DISTINCT c.id, c.number, c.title FROM contract_clauses cc JOIN contracts c ON c.id=cc.contract_id WHERE cc.workspace_id=? AND cc.category='E01' AND cc.deviation_level='prohibited' AND c.deleted_at IS NULL", ctx.ws);
  const queue = rows.filter((r) => ["INTERNAL_REVIEW", "PENDING_APPROVAL", "NEGOTIATION"].includes(String(r.status)));
  const slaBreached = queue.filter((r) => r.sla_due_at && String(r.sla_due_at) < now() && !r.sla_paused).length;
  const byType: Record<string, { n: number; value: number }> = {}; active.forEach((r) => { const k = String(r.type_name); byType[k] = byType[k] ?? { n: 0, value: 0 }; byType[k]!.n++; byType[k]!.value += Number(r.annual_value); });
  const expiringByMonth: Record<string, number> = {}; active.forEach((r) => { if (r.end_date) { const k = String(r.end_date).slice(0, 7); expiringByMonth[k] = (expiringByMonth[k] ?? 0) + Number(r.annual_value); } });
  return { total: rows.length, active: active.length, by_status: byStatus, cycle_days: { median: Math.round(median), p90: Math.round(p90), n: signed.length }, value: { income_annual: income, expense_annual: expense, expiring_12m: in12.reduce((a, r) => a + Number(r.annual_value), 0), expiring_12m_count: in12.length, concentration_top5: totalCp ? Math.round((100 * top5.reduce((a, x) => a + x[1], 0)) / totalCp) : 0 }, risk, obligations: { fulfilled: Number(obl.ok) || 0, breached: Number(obl.bad) || 0, open: Number(obl.open) || 0 }, auto_renewals: autoRen, compliance: { no_dpa: noDpa, payment_gt_60: payGt60, unlimited_liability: unlimited }, queue: { open: queue.length, sla_breached: slaBreached, avg_days: queue.length ? Math.round(queue.reduce((a, r) => a + (Date.now() - new Date(String(r.requested_at ?? r.created_at)).getTime()) / 864e5, 0) / queue.length) : 0 }, by_type: Object.entries(byType).map(([name, v]) => ({ name, ...v })), expiring_by_month: Object.entries(expiringByMonth).sort().map(([month, value]) => ({ month, value })), auto_renew_pct: active.length ? Math.round((100 * active.filter((r) => r.renewal_type === "auto").length) / active.length) : 0 };
}
export function calendar(ctx: Ctx, from: string, to: string) {
  assert(ctx, "contract", "read");
  const scope = ownerScope(ctx, "c.owner_id");
  const ms = ctx.db.all<Row>(`SELECT m.id, m.type, m.label, m.date, m.status, c.id AS contract_id, c.number, c.title, 'milestone' AS kind FROM milestones m JOIN contracts c ON c.id=m.contract_id WHERE m.workspace_id=? AND m.date BETWEEN ? AND ? AND c.deleted_at IS NULL AND ${scope.sql}`, ctx.ws, from, to, ...scope.params);
  const ob = ctx.db.all<Row>(`SELECT o.id, o.type, o.title AS label, o.due_date AS date, o.status, c.id AS contract_id, c.number, c.title, 'obligation' AS kind FROM obligations o JOIN contracts c ON c.id=o.contract_id WHERE o.workspace_id=? AND o.due_date BETWEEN ? AND ? AND c.deleted_at IS NULL AND ${scope.sql}`, ctx.ws, from, to, ...scope.params);
  const pay = ctx.db.all<Row>(`SELECT p.id, p.type, p.label, p.due_date AS date, p.status, p.amount, c.id AS contract_id, c.number, c.title, 'payment' AS kind FROM payment_schedule p JOIN contracts c ON c.id=p.contract_id WHERE p.workspace_id=? AND p.due_date BETWEEN ? AND ? AND c.deleted_at IS NULL AND ${scope.sql}`, ctx.ws, from, to, ...scope.params);
  return [...ms, ...ob, ...pay].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
