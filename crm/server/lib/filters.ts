/**
 * Filter DSL -> SQL. Used by list views, dynamic lists, workflow conditions and reports.
 * { logic: 'and'|'or', conditions: [{ field, op, value }] }
 * Fields: whitelisted column names per object, or "custom.<key>" (JSON column).
 */
import { badRequest } from "./errors.js";
import { isCustomObjectKey } from "./objectKeys.js";

export type Condition = { field: string; op: string; value?: unknown };
export type FilterGroup = { logic?: "and" | "or"; conditions?: Condition[] };

const CORE_FIELDS: Record<string, Record<string, "text" | "number" | "date" | "bool" | "json">> = {
  contact: {
    first_name: "text", last_name: "text", email: "text", phone: "text", job_title: "text", company_id: "text",
    lifecycle_stage: "text", lead_status: "text", source: "text", owner_id: "text", score: "number", language: "text",
    city: "text", country: "text", consent_marketing: "bool", do_not_contact: "bool", tags: "json",
    last_activity_at: "date", last_contacted_at: "date", created_at: "date", updated_at: "date", birthday: "date",
  },
  company: {
    name: "text", domain: "text", sector: "text", size: "number", revenue: "number", city: "text", country: "text",
    owner_id: "text", type: "text", status: "text", tags: "json", last_activity_at: "date", created_at: "date", parent_id: "text",
  },
  deal: {
    name: "text", company_id: "text", pipeline_id: "text", stage_id: "text", amount: "number", currency: "text",
    probability: "number", expected_close_date: "date", closed_at: "date", status: "text", loss_reason: "text",
    owner_id: "text", source: "text", stage_entered_at: "date", next_activity_at: "date", last_activity_at: "date",
    created_at: "date", tags: "json",
  },
  ticket: {
    subject: "text", status: "text", priority: "text", category: "text", assignee_id: "text", channel: "text",
    contact_id: "text", company_id: "text", created_at: "date", sla_due_at: "date", resolved_at: "date", tags: "json",
  },
  task: { title: "text", type: "text", priority: "text", assignee_id: "text", due_at: "date", completed_at: "date", created_at: "date" },
  contract: {
    number: "text", title: "text", type_id: "text", counterparty_company_id: "text", deal_id: "text", owner_id: "text", legal_owner_id: "text", department: "text",
    status: "text", kind: "text", parent_id: "text", paper_origin: "text", language: "text", governing_law: "text", requested_at: "date", signed_at: "date", effective_date: "date", end_date: "date",
    term_type: "text", renewal_type: "text", notice_deadline: "date", total_value: "number", annual_value: "number", currency: "text", payment_model: "text", payment_terms_days: "number",
    risk_level: "text", risk_score: "number", confidentiality: "text", contains_personal_data: "bool", data_role: "text", dora_in_scope: "bool", urgency: "text", source: "text",
    legal_hold: "bool", created_at: "date", updated_at: "date", tags: "json",
  },
};
/** Columnas nativas de los registros de cualquier objeto personalizado (o_<slug>). */
export const CUSTOM_RECORD_FIELDS: Record<string, "text" | "number" | "date" | "bool" | "json"> = { name: "text", number: "text", owner_id: "text", status: "text", created_at: "date", updated_at: "date", tags: "json" };
// Los objetos personalizados no se enumeran (Object.keys sigue devolviendo solo los nativos), pero se resuelven al pedirlos.

export const OBJECT_FIELDS: Record<string, Record<string, "text" | "number" | "date" | "bool" | "json">> = new Proxy(CORE_FIELDS, { get: (t, p) => (typeof p === "string" && isCustomObjectKey(p) ? CUSTOM_RECORD_FIELDS : (t as Record<string | symbol, never>)[p]) });

export const OPS = ["eq", "neq", "contains", "not_contains", "starts", "gt", "gte", "lt", "lte", "empty", "not_empty", "in", "not_in", "last_days", "next_days", "before", "after", "today", "is_true", "is_false"];

export function buildWhere(object: string, group: FilterGroup | undefined, alias = ""): { sql: string; params: unknown[] } {
  const fields = OBJECT_FIELDS[object];
  if (!fields) throw badRequest(`Objeto desconocido: ${object}`);
  const conds = group?.conditions ?? [];
  if (!conds.length) return { sql: "1=1", params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = alias ? `${alias}.` : "";
  for (const c of conds) {
    let col: string;
    let kind: string;
    if (c.field.startsWith("custom.")) {
      const key = c.field.slice(7);
      if (!/^[a-z0-9_]+$/i.test(key)) throw badRequest(`Campo no válido: ${c.field}`);
      col = `json_extract(${p}custom, '$.${key}')`;
      kind = "text";
    } else {
      const k = fields[c.field];
      if (!k) throw badRequest(`Campo no filtrable: ${c.field}`);
      col = `${p}${c.field}`;
      kind = k;
    }
    const v = c.value;
    switch (c.op) {
      case "eq":
        parts.push(`${col} = ?`); params.push(v); break;
      case "neq":
        parts.push(`(${col} IS NULL OR ${col} != ?)`); params.push(v); break;
      case "contains":
        if (kind === "json") { parts.push(`${col} LIKE ?`); params.push(`%"${String(v)}"%`); }
        else { parts.push(`${col} LIKE ?`); params.push(`%${String(v)}%`); }
        break;
      case "not_contains":
        parts.push(`(${col} IS NULL OR ${col} NOT LIKE ?)`); params.push(`%${String(v)}%`); break;
      case "starts":
        parts.push(`${col} LIKE ?`); params.push(`${String(v)}%`); break;
      case "gt": parts.push(`${col} > ?`); params.push(v); break;
      case "gte": parts.push(`${col} >= ?`); params.push(v); break;
      case "lt": parts.push(`${col} < ?`); params.push(v); break;
      case "lte": parts.push(`${col} <= ?`); params.push(v); break;
      case "empty": parts.push(`(${col} IS NULL OR ${col} = '' OR ${col} = '[]')`); break;
      case "not_empty": parts.push(`(${col} IS NOT NULL AND ${col} != '' AND ${col} != '[]')`); break;
      case "in": {
        const arr = Array.isArray(v) ? v : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!arr.length) { parts.push("0=1"); break; }
        parts.push(`${col} IN (${arr.map(() => "?").join(",")})`); params.push(...arr); break;
      }
      case "not_in": {
        const arr = Array.isArray(v) ? v : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!arr.length) break;
        parts.push(`(${col} IS NULL OR ${col} NOT IN (${arr.map(() => "?").join(",")}))`); params.push(...arr); break;
      }
      case "last_days": parts.push(`${col} >= datetime('now', ?)`); params.push(`-${Number(v) || 0} days`); break;
      case "next_days": parts.push(`(${col} >= datetime('now') AND ${col} <= datetime('now', ?))`); params.push(`+${Number(v) || 0} days`); break;
      case "before": parts.push(`${col} < ?`); params.push(v); break;
      case "after": parts.push(`${col} > ?`); params.push(v); break;
      case "today": parts.push(`date(${col}) = date('now')`); break;
      case "is_true": parts.push(`${col} = 1`); break;
      case "is_false": parts.push(`(${col} = 0 OR ${col} IS NULL)`); break;
      default:
        throw badRequest(`Operador no válido: ${c.op}`);
    }
  }
  const logic = group?.logic === "or" ? " OR " : " AND ";
  return { sql: `(${parts.join(logic)})`, params };
}

/** Evaluate a filter group in memory against a record (used by workflow conditions). */
export function matches(record: Record<string, unknown>, group: FilterGroup | undefined): boolean {
  const conds = group?.conditions ?? [];
  if (!conds.length) return true;
  const results = conds.map((c) => {
    const raw = c.field.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), record);
    const v = c.value;
    const s = raw === null || raw === undefined ? "" : String(raw);
    const n = Number(raw);
    const nv = Number(v);
    switch (c.op) {
      case "eq": return s === String(v ?? "") || (typeof raw === "number" && n === nv);
      case "neq": return !(s === String(v ?? "") || (typeof raw === "number" && n === nv));
      case "contains": return Array.isArray(raw) ? raw.includes(v) : s.toLowerCase().includes(String(v ?? "").toLowerCase());
      case "not_contains": return Array.isArray(raw) ? !raw.includes(v) : !s.toLowerCase().includes(String(v ?? "").toLowerCase());
      case "starts": return s.toLowerCase().startsWith(String(v ?? "").toLowerCase());
      case "gt": return typeof raw === "number" ? n > nv : s > String(v);
      case "gte": return typeof raw === "number" ? n >= nv : s >= String(v);
      case "lt": return typeof raw === "number" ? n < nv : s < String(v);
      case "lte": return typeof raw === "number" ? n <= nv : s <= String(v);
      case "empty": return raw === null || raw === undefined || s === "" || (Array.isArray(raw) && raw.length === 0);
      case "not_empty": return !(raw === null || raw === undefined || s === "" || (Array.isArray(raw) && raw.length === 0));
      case "in": return (Array.isArray(v) ? v : String(v ?? "").split(",").map((x) => x.trim())).includes(s);
      case "not_in": return !(Array.isArray(v) ? v : String(v ?? "").split(",").map((x) => x.trim())).includes(s);
      case "last_days": return !!s && Date.now() - new Date(s).getTime() <= (Number(v) || 0) * 86400000;
      case "next_days": { const t = new Date(s).getTime(); return !!s && t >= Date.now() && t <= Date.now() + (Number(v) || 0) * 86400000; }
      case "before": return !!s && s < String(v);
      case "after": return !!s && s > String(v);
      case "today": return s.slice(0, 10) === new Date().toISOString().slice(0, 10);
      case "is_true": return raw === 1 || raw === true;
      case "is_false": return !(raw === 1 || raw === true);
      default: return false;
    }
  });
  return group?.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}
