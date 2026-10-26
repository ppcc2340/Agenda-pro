/**
 * Analítica: constructor de informes (objeto + filtros + hasta 2 agrupaciones + métricas), KPIs para paneles,
 * embudo etapa a etapa, previsión vs real, cuotas, motivos de pérdida, informes programados y alertas de métricas.
 * Todo respeta la visibilidad del rol igual que los listados (ownerScope sobre la columna de propietario).
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import type { Db, Row } from "../db.js";
import { parseJson } from "../db.js";
import { buildWhere, OBJECT_FIELDS, type FilterGroup } from "../lib/filters.js";
import { ownerScope, assert, can, isAdmin } from "../lib/permissions.js";
import { isCustomObjectKey } from "../lib/objectKeys.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { id, now } from "../lib/util.js";
import { fieldDefs, statusLabels } from "./columns.js";
import { LOSS_LABELS } from "./deals.js";
import { notify } from "./notifications.js";
import { sendMail } from "./email.js";
import { ctxAs, systemCtx } from "./system.js";

/* ------------------------------------------------------------------ definición */
export const REPORT_OBJECTS = ["contact", "company", "deal", "ticket", "task", "contract", "activity"] as const;
// los objetos personalizados (o_<slug>) se resuelven con los valores comunes de custom_records
const withCustom = (core: Record<string, string>, custom: string): Record<string, string> => new Proxy(core, { get: (t, p) => (typeof p === "string" && isCustomObjectKey(p) ? custom : (t as Record<string | symbol, never>)[p]) });
const TABLE: Record<string, string> = withCustom({ contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", task: "tasks", contract: "contracts", activity: "activities" }, "custom_records");
const OWNER_COL: Record<string, string> = withCustom({ contact: "owner_id", company: "owner_id", deal: "owner_id", ticket: "assignee_id", task: "assignee_id", contract: "owner_id", activity: "user_id" }, "owner_id");
const PERM_OBJ: Record<string, string> = { activity: "activity" };
const SOFT_DELETE = { has: (o: string) => ["contact", "company", "deal", "contract"].includes(o) || isCustomObjectKey(o) };
export const DATE_FIELD: Record<string, string> = withCustom({ contact: "created_at", company: "created_at", deal: "created_at", ticket: "created_at", task: "due_at", contract: "created_at", activity: "occurred_at" }, "created_at");
/** Informes sobre objetos nativos o sobre cualquier objeto personalizado que exista en la cuenta. */
export const isReportObject = (ctx: Ctx, o: string) => (REPORT_OBJECTS as readonly string[]).includes(o) || (isCustomObjectKey(o) && !!ctx.db.get("SELECT id FROM custom_objects WHERE workspace_id=? AND key=?", ctx.ws, o));
const USER_FIELDS = new Set(["owner_id", "assignee_id", "user_id", "legal_owner_id"]);
export const BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export const METRIC_FNS = ["count", "sum", "avg", "min", "max"] as const;
export const CHARTS = ["bar", "stacked", "line", "pie", "table", "kpi"] as const;

export const reportConfigSchema = z.object({
  filters: z.object({ logic: z.enum(["and", "or"]).optional(), conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).optional() }).optional(),
  dims: z.array(z.object({ field: z.string(), bucket: z.enum(BUCKETS).optional() })).max(2).default([]),
  metrics: z.array(z.object({ fn: z.enum(METRIC_FNS), field: z.string().optional(), label: z.string().max(60).optional() })).min(1).max(4).default([{ fn: "count" }]),
  chart: z.enum(CHARTS).default("bar"),
  sort: z.object({ by: z.enum(["dim", "metric"]).default("metric"), dir: z.enum(["asc", "desc"]).default("desc") }).default({ by: "metric", dir: "desc" }),
  limit: z.number().int().min(1).max(500).default(50),
  date_field: z.string().optional(),
});
export type ReportConfig = z.infer<typeof reportConfigSchema>;
export const globalSchema = z.object({ from: z.string().optional(), to: z.string().optional(), owner_id: z.string().optional(), team_id: z.string().optional(), pipeline_id: z.string().optional() }).default({});
export type GlobalFilters = z.infer<typeof globalSchema>;

export const ACTIVITY_FIELDS: Record<string, "text" | "number" | "date"> = { type: "text", subject: "text", outcome: "text", direction: "text", user_id: "text", contact_id: "text", company_id: "text", deal_id: "text", ticket_id: "text", occurred_at: "date", duration_min: "number" };
if (!OBJECT_FIELDS.activity) OBJECT_FIELDS.activity = ACTIVITY_FIELDS as never;

function fieldKind(ctx: Ctx, object: string, field: string): { col: string; kind: string; custom?: ReturnType<typeof fieldDefs>[number] } {
  if (field.startsWith("custom.")) {
    const key = field.slice(7);
    if (!/^[a-z0-9_]+$/i.test(key)) throw badRequest(`Campo no válido: ${field}`);
    const d = fieldDefs(ctx, object).find((x) => x.key === key);
    if (!d) throw badRequest(`Columna desconocida: ${field}`);
    const kind = ["number", "currency", "percent", "rating"].includes(d.type) ? "number" : ["date", "datetime"].includes(d.type) ? "date" : "text";
    return { col: kind === "number" ? `CAST(json_extract(t.custom,'$.${key}') AS REAL)` : `json_extract(t.custom,'$.${key}')`, kind, custom: d };
  }
  const k = OBJECT_FIELDS[object]?.[field];
  if (!k || k === "json") throw badRequest(`No se puede usar «${field}» en un informe`);
  return { col: `t.${field}`, kind: k };
}
function bucketExpr(col: string, b: string): string {
  switch (b) {
    case "day": return `date(${col})`;
    case "week": return `strftime('%Y-S%W', ${col})`;
    case "month": return `substr(${col},1,7)`;
    case "quarter": return `(substr(${col},1,4) || '-T' || ((CAST(substr(${col},6,2) AS INTEGER) + 2) / 3))`;
    case "year": return `substr(${col},1,4)`;
    default: throw badRequest("Agrupación de fecha no válida");
  }
}

/** WHERE común: espacio, borrado lógico, visibilidad del rol, filtros del informe y filtros globales del panel. */
function baseWhere(ctx: Ctx, object: string, filters: FilterGroup | undefined, g: GlobalFilters, dateField?: string): { sql: string; params: unknown[] } {
  const where = ["t.workspace_id = ?"]; const params: unknown[] = [ctx.ws];
  if (SOFT_DELETE.has(object)) where.push("t.deleted_at IS NULL");
  if (isCustomObjectKey(object)) { where.push("t.object_key = ?"); params.push(object); }
  const owner = `t.${OWNER_COL[object]}`;
  const s = ownerScope(ctx, owner); where.push(s.sql); params.push(...s.params);
  const f = buildWhere(object, filters, "t"); where.push(f.sql); params.push(...f.params);
  const df = dateField && (OBJECT_FIELDS[object]?.[dateField] === "date") ? `t.${dateField}` : `t.${DATE_FIELD[object]}`;
  if (g.from) { where.push(`${df} >= ?`); params.push(g.from); }
  if (g.to) { where.push(`${df} <= ?`); params.push(g.to.length === 10 ? `${g.to}T23:59:59` : g.to); }
  if (g.owner_id) { where.push(`${owner} = ?`); params.push(g.owner_id); }
  if (g.team_id) { where.push(`${owner} IN (SELECT id FROM users WHERE workspace_id=? AND team_id=?)`); params.push(ctx.ws, g.team_id); }
  if (g.pipeline_id && object === "deal") { where.push("t.pipeline_id = ?"); params.push(g.pipeline_id); }
  return { sql: where.join(" AND "), params };
}

export interface ReportResult { object: string; dims: { key: string; label: string; field: string }[]; metrics: { key: string; label: string; fn: string; field?: string; money: boolean }[]; rows: Record<string, unknown>[]; totals: Record<string, number>; chart: string; truncated: boolean }

const METRIC_LABEL: Record<string, string> = { count: "Recuento", sum: "Suma", avg: "Media", min: "Mínimo", max: "Máximo" };
const MONEY_FIELDS = new Set(["amount", "revenue", "total_value", "annual_value"]);

function fieldLabel(ctx: Ctx, object: string, field: string): string {
  if (field.startsWith("custom.")) return fieldDefs(ctx, object).find((x) => x.key === field.slice(7))?.label ?? field;
  return FIELD_LABELS[field] ?? field;
}
export const FIELD_LABELS: Record<string, string> = {
  owner_id: "Propietario", assignee_id: "Asignado", user_id: "Usuario", legal_owner_id: "Legal", stage_id: "Etapa", pipeline_id: "Pipeline", status: "Estado", source: "Origen", lifecycle_stage: "Ciclo de vida", lead_status: "Estado del lead",
  company_id: "Empresa", contact_id: "Contacto", deal_id: "Negocio", ticket_id: "Ticket", type: "Tipo", priority: "Prioridad", category: "Categoría", channel: "Canal", sector: "Sector", city: "Ciudad", country: "País", loss_reason: "Motivo de pérdida",
  amount: "Importe", probability: "Probabilidad", revenue: "Facturación", size: "Empleados", score: "Puntuación", created_at: "Fecha de creación", closed_at: "Fecha de cierre", expected_close_date: "Cierre previsto", due_at: "Vencimiento", occurred_at: "Fecha",
  type_id: "Tipo de contrato", counterparty_company_id: "Contraparte", risk_level: "Riesgo", total_value: "Valor total", annual_value: "Valor anual", end_date: "Fin", signed_at: "Firma", duration_min: "Duración (min)", outcome: "Resultado", direction: "Dirección", currency: "Moneda", department: "Departamento",
};

/** Resuelve los valores de una dimensión a etiquetas legibles (usuarios, etapas, empresas, etiquetas de estado…). */
function labeler(ctx: Ctx, object: string, field: string): (v: unknown) => string {
  const db = ctx.db;
  const lookup = (sql: string) => { const m = new Map(db.all<{ id: string; n: string }>(sql, ctx.ws).map((r) => [String(r.id), String(r.n)])); return (v: unknown) => (v == null || v === "" ? "(vacío)" : m.get(String(v)) ?? String(v)); };
  if (field.startsWith("custom.")) {
    const d = fieldDefs(ctx, object).find((x) => x.key === field.slice(7));
    if (d?.type === "status") { const ls = statusLabels(ctx, d); return (v) => (v == null ? "(vacío)" : ls.find((l) => String(l.id) === String(v))?.label ?? String(v)); }
    if (d?.type === "user") return lookup("SELECT id, name n FROM users WHERE workspace_id=?");
    if (d?.type === "boolean") return (v) => (v == null ? "(vacío)" : v === 1 || v === true || v === "true" ? "Sí" : "No");
    return (v) => (v == null || v === "" ? "(vacío)" : String(v));
  }
  if (USER_FIELDS.has(field)) return lookup("SELECT id, name n FROM users WHERE workspace_id=?");
  if (isCustomObjectKey(object) && field === "status") { const st = parseJson(db.get<Row>("SELECT statuses FROM custom_objects WHERE workspace_id=? AND key=?", ctx.ws, object), ["statuses"])?.statuses as { id: number; label: string }[] | undefined; return (v) => (v == null || v === "" ? "(vacío)" : st?.find((s) => String(s.id) === String(v))?.label ?? String(v)); }
  if (field === "stage_id") return lookup("SELECT id, name n FROM stages WHERE workspace_id=?");
  if (field === "pipeline_id") return lookup("SELECT id, name n FROM pipelines WHERE workspace_id=?");
  if (field === "company_id" || field === "counterparty_company_id" || field === "parent_id") return lookup("SELECT id, name n FROM companies WHERE workspace_id=?");
  if (field === "contact_id") return lookup("SELECT id, first_name || ' ' || last_name n FROM contacts WHERE workspace_id=?");
  if (field === "deal_id") return lookup("SELECT id, name n FROM deals WHERE workspace_id=?");
  if (field === "type_id") return lookup("SELECT id, name n FROM contract_types WHERE workspace_id=?");
  if (field === "loss_reason") return (v) => (v == null ? "(sin motivo)" : LOSS_LABELS[String(v)] ?? String(v));
  if (OBJECT_FIELDS[object]?.[field] === "bool") return (v) => (v === 1 ? "Sí" : "No");
  return (v) => (v == null || v === "" ? "(vacío)" : String(v));
}

export function runReport(ctx: Ctx, object: string, rawConfig: unknown, g: GlobalFilters = {}): ReportResult {
  if (!isReportObject(ctx, object)) throw badRequest("Objeto no válido para informes");
  assert(ctx, PERM_OBJ[object] ?? object, "read");
  const cfg = reportConfigSchema.parse(rawConfig ?? {});
  const w = baseWhere(ctx, object, cfg.filters as FilterGroup, g, cfg.date_field);
  const sel: string[] = []; const groupBy: string[] = [];
  const dims = cfg.dims.map((d, i) => {
    const f = fieldKind(ctx, object, d.field);
    let expr = f.col;
    if (d.bucket) { if (f.kind !== "date") throw badRequest(`«${d.field}» no es una fecha`); expr = bucketExpr(f.col, d.bucket); }
    sel.push(`${expr} AS d${i}`); groupBy.push(`d${i}`);
    return { key: `d${i}`, field: d.field, bucket: d.bucket, label: fieldLabel(ctx, object, d.field) + (d.bucket ? ` (${{ day: "día", week: "semana", month: "mes", quarter: "trimestre", year: "año" }[d.bucket]})` : "") };
  });
  const metrics = cfg.metrics.map((m, i) => {
    let expr = "COUNT(*)"; let money = false;
    if (m.fn !== "count") {
      if (!m.field) throw badRequest(`La métrica ${METRIC_LABEL[m.fn]} necesita un campo numérico`);
      const f = fieldKind(ctx, object, m.field);
      if (f.kind !== "number") throw badRequest(`«${m.field}» no es numérico`);
      expr = `${m.fn.toUpperCase()}(${f.col})`;
      money = MONEY_FIELDS.has(m.field) || f.custom?.type === "currency";
    }
    sel.push(`${expr} AS m${i}`);
    return { key: `m${i}`, fn: m.fn, field: m.field, money, label: m.label || (m.fn === "count" ? "Recuento" : `${METRIC_LABEL[m.fn]} de ${fieldLabel(ctx, object, m.field!).toLowerCase()}`) };
  });
  const table = TABLE[object]!;
  // las etapas se ordenan como en el pipeline (abiertas por posición, luego ganado y perdido)
  const dimOrder = (i: number) => (cfg.dims[i]?.field === "stage_id" && !cfg.dims[i]?.bucket ? `(SELECT CASE kind WHEN 'open' THEN position WHEN 'won' THEN 1000 ELSE 1001 END FROM stages WHERE id=d${i})` : `d${i}`);
  const order = dims.length ? (cfg.sort.by === "dim" ? `${dimOrder(0)} ${cfg.sort.dir}${dims.length > 1 ? `, ${dimOrder(1)}` : ""}` : `m0 ${cfg.sort.dir}`) : "";
  const sql = `SELECT ${sel.join(", ")} FROM ${table} t WHERE ${w.sql}${groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : ""}${order ? ` ORDER BY ${order} NULLS LAST` : ""} LIMIT ${cfg.limit + 1}`;
  let rows = ctx.db.all<Row>(sql, ...w.params);
  const truncated = rows.length > cfg.limit; if (truncated) rows = rows.slice(0, cfg.limit);
  dims.forEach((d) => { const lab = labeler(ctx, object, d.field); rows.forEach((r) => { r[`${d.key}_label`] = d.field && !cfg.dims[Number(d.key.slice(1))]?.bucket ? lab(r[d.key]) : (r[d.key] == null ? "(vacío)" : String(r[d.key])); }); });
  rows.forEach((r) => metrics.forEach((m) => { const v = r[m.key]; r[m.key] = v == null ? 0 : Math.round(Number(v) * 100) / 100; }));
  // totales sobre todo el conjunto filtrado (no solo las filas mostradas)
  const tsel = metrics.map((m, i) => `${m.fn === "count" ? "COUNT(*)" : `${m.fn.toUpperCase()}(${fieldKind(ctx, object, cfg.metrics[i]!.field!).col})`} AS ${m.key}`).join(", ");
  const tot = ctx.db.get<Row>(`SELECT ${tsel} FROM ${table} t WHERE ${w.sql}`, ...w.params) ?? {};
  const totals = Object.fromEntries(metrics.map((m) => [m.key, Math.round(Number(tot[m.key] ?? 0) * 100) / 100]));
  return { object, dims, metrics, rows, totals, chart: cfg.chart, truncated };
}

export function toCsv(res: ReportResult): string {
  const head = [...res.dims.map((d) => d.label), ...res.metrics.map((m) => m.label)];
  const esc = (v: unknown) => { const s = v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.map(esc).join(";"), ...res.rows.map((r) => [...res.dims.map((d) => r[`${d.key}_label`]), ...res.metrics.map((m) => r[m.key])].map(esc).join(";"))];
  if (res.dims.length) lines.push(["Total", ...res.dims.slice(1).map(() => ""), ...res.metrics.map((m) => res.totals[m.key])].map(esc).join(";"));
  return "﻿" + lines.join("\r\n");
}

/* ------------------------------------------------------------------ informes guardados */
export const savedReportSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().optional(), object: z.string().refine((o) => (REPORT_OBJECTS as readonly string[]).includes(o) || isCustomObjectKey(o), "Objeto no válido para informes"), config: reportConfigSchema, visibility: z.enum(["private", "team", "all"]).default("private") });
const visibleSql = (ctx: Ctx, alias = "") => {
  const p = alias ? `${alias}.` : "";
  if (isAdmin(ctx)) return { sql: "1=1", params: [] as unknown[] };
  return { sql: `(${p}owner_id = ? OR ${p}visibility = 'all' OR (${p}visibility = 'team' AND ${p}team_id IS NOT NULL AND ${p}team_id = ?) OR (${p}visibility = 'role' AND ${p}role_key = ?))`, params: [ctx.user.id, ctx.user.team_id ?? "", ctx.role.key] as unknown[] };
};
export function listReports(ctx: Ctx) {
  const v = visibleSql(ctx, "r");
  return ctx.db.all<Row>(`SELECT r.*, (SELECT name FROM users WHERE id=r.owner_id) owner_name FROM saved_reports r WHERE r.workspace_id=? AND ${v.sql} ORDER BY r.updated_at DESC`, ctx.ws, ...v.params).map((r) => parseJson(r, ["config"]));
}
export function getReport(ctx: Ctx, rid: string): Row {
  const v = visibleSql(ctx);
  const r = ctx.db.get<Row>(`SELECT * FROM saved_reports WHERE id=? AND workspace_id=? AND ${v.sql}`, rid, ctx.ws, ...v.params);
  if (!r) throw notFound("Informe");
  return parseJson(r, ["config"]) as Row;
}
const canShare = (ctx: Ctx) => isAdmin(ctx) || can(ctx, "report", "update") || can(ctx, "report", "create");
export function saveReport(ctx: Ctx, input: unknown, rid?: string): Row {
  assert(ctx, "report", "read");
  const b = savedReportSchema.parse(input);
  if (b.visibility !== "private" && !canShare(ctx)) throw forbidden("Tu rol solo permite informes privados");
  runReport(ctx, b.object, b.config, {}); // valida la definición antes de guardar
  if (rid) {
    const cur = getReport(ctx, rid);
    if (cur.owner_id !== ctx.user.id && !isAdmin(ctx)) throw forbidden("Solo el autor puede modificar este informe; duplícalo para tener tu copia");
    ctx.db.update("saved_reports", rid, { name: b.name, description: b.description ?? null, object: b.object, config: b.config, visibility: b.visibility, team_id: ctx.user.team_id ?? null, updated_at: now() });
    return getReport(ctx, rid);
  }
  const nid = id();
  ctx.db.insert("saved_reports", { id: nid, workspace_id: ctx.ws, owner_id: ctx.user.id, team_id: ctx.user.team_id ?? null, role_key: null, name: b.name, description: b.description ?? null, object: b.object, config: b.config, visibility: b.visibility, created_at: now(), updated_at: now() });
  return getReport(ctx, nid);
}
export function deleteReport(ctx: Ctx, rid: string) {
  const cur = getReport(ctx, rid);
  if (cur.owner_id !== ctx.user.id && !isAdmin(ctx)) throw forbidden("Solo el autor puede borrar este informe");
  ctx.db.run("DELETE FROM saved_reports WHERE id=?", rid);
  ctx.db.run("DELETE FROM report_schedules WHERE report_id=?", rid);
}
export function duplicateReport(ctx: Ctx, rid: string): Row {
  const cur = getReport(ctx, rid);
  return saveReport(ctx, { name: `${cur.name} (copia)`, description: cur.description, object: cur.object, config: cur.config, visibility: "private" });
}

/* ------------------------------------------------------------------ KPIs y analítica comercial */
export const KPIS: Record<string, { label: string; money?: boolean; pct?: boolean }> = {
  won_amount: { label: "Importe ganado", money: true }, won_count: { label: "Negocios ganados" }, open_pipeline: { label: "Pipeline abierto", money: true }, weighted_pipeline: { label: "Pipeline ponderado", money: true },
  conversion_rate: { label: "Tasa de conversión", pct: true }, avg_deal: { label: "Ticket medio", money: true }, new_leads: { label: "Leads nuevos" }, activities: { label: "Actividades" },
  overdue_tasks: { label: "Tareas vencidas" }, open_tickets: { label: "Tickets abiertos" }, sla_breached: { label: "SLA incumplidos" }, quota_attainment: { label: "Cumplimiento de cuota", pct: true },
};
function period(g: GlobalFilters) {
  const to = g.to || new Date().toISOString().slice(0, 10);
  const from = g.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  return { from, to: `${to.slice(0, 10)}T23:59:59` };
}
function scope(ctx: Ctx, col: string, g: GlobalFilters) {
  const s = ownerScope(ctx, col); const parts = [s.sql]; const params = [...s.params];
  if (g.owner_id) { parts.push(`${col}=?`); params.push(g.owner_id); }
  if (g.team_id) { parts.push(`${col} IN (SELECT id FROM users WHERE workspace_id=? AND team_id=?)`); params.push(ctx.ws, g.team_id); }
  return { sql: parts.join(" AND "), params };
}
export function kpi(ctx: Ctx, key: string, g: GlobalFilters = {}): { key: string; label: string; value: number; money?: boolean; pct?: boolean; previous: number | null } {
  const def = KPIS[key]; if (!def) throw badRequest("KPI desconocido");
  const p = period(g);
  const span = Math.max(1, Math.round((Date.parse(p.to) - Date.parse(`${p.from}T00:00:00`)) / 864e5));
  const prev = { ...g, from: new Date(Date.parse(`${p.from}T00:00:00Z`) - span * 864e5).toISOString().slice(0, 10), to: new Date(Date.parse(`${p.from}T00:00:00Z`) - 864e5).toISOString().slice(0, 10) };
  const value = kpiValue(ctx, key, g);
  const previous = ["open_pipeline", "weighted_pipeline", "overdue_tasks", "open_tickets", "quota_attainment"].includes(key) ? null : kpiValue(ctx, key, prev);
  return { key, ...def, value, previous };
}
export function kpiValue(ctx: Ctx, key: string, g: GlobalFilters): number {
  const db = ctx.db; const ws = ctx.ws; const p = period(g);
  const d = scope(ctx, "owner_id", g);
  const pipe = g.pipeline_id ? " AND pipeline_id=?" : ""; const pp = g.pipeline_id ? [g.pipeline_id] : [];
  const n = (sql: string, ...params: unknown[]) => Number(Object.values(db.get<Row>(sql, ...params) ?? {})[0] ?? 0) || 0;
  switch (key) {
    case "won_amount": return n(`SELECT COALESCE(SUM(amount),0) FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe}`, ws, p.from, p.to, ...d.params, ...pp);
    case "won_count": return n(`SELECT COUNT(*) FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe}`, ws, p.from, p.to, ...d.params, ...pp);
    case "avg_deal": return Math.round(n(`SELECT COALESCE(AVG(amount),0) FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe}`, ws, p.from, p.to, ...d.params, ...pp));
    case "open_pipeline": return n(`SELECT COALESCE(SUM(amount),0) FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND ${d.sql}${pipe}`, ws, ...d.params, ...pp);
    case "weighted_pipeline": return Math.round(n(`SELECT COALESCE(SUM(amount*probability/100.0),0) FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND ${d.sql}${pipe}`, ws, ...d.params, ...pp));
    case "conversion_rate": { const r = db.get<{ won: number; lost: number }>(`SELECT COALESCE(SUM(status='won'),0) won, COALESCE(SUM(status='lost'),0) lost FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status IN ('won','lost') AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe}`, ws, p.from, p.to, ...d.params, ...pp); const t = Number(r?.won ?? 0) + Number(r?.lost ?? 0); return t ? Math.round((1000 * Number(r!.won)) / t) / 10 : 0; }
    case "new_leads": return n(`SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND created_at BETWEEN ? AND ? AND ${d.sql}`, ws, p.from, p.to, ...d.params);
    case "activities": { const a = scope(ctx, "user_id", g); return n(`SELECT COUNT(*) FROM activities WHERE workspace_id=? AND type!='system' AND occurred_at BETWEEN ? AND ? AND ${a.sql}`, ws, p.from, p.to, ...a.params); }
    case "overdue_tasks": { const a = scope(ctx, "assignee_id", g); return n(`SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND completed_at IS NULL AND due_at < ? AND ${a.sql}`, ws, now(), ...a.params); }
    case "open_tickets": { const a = scope(ctx, "assignee_id", g); return n(`SELECT COUNT(*) FROM tickets WHERE workspace_id=? AND status IN ('new','open','pending') AND ${a.sql}`, ws, ...a.params); }
    case "sla_breached": { const a = scope(ctx, "assignee_id", g); return n(`SELECT COUNT(*) FROM tickets WHERE workspace_id=? AND created_at BETWEEN ? AND ? AND (first_response_at > sla_due_at OR (first_response_at IS NULL AND sla_due_at < ? AND status IN ('new','open'))) AND ${a.sql}`, ws, p.from, p.to, now(), ...a.params); }
    case "quota_attainment": { const q = quotaReport(ctx, { ...g, month: p.to.slice(0, 7) }); return q.totals.quota ? Math.round((1000 * q.totals.won) / q.totals.quota) / 10 : 0; }
    default: throw badRequest("KPI desconocido");
  }
}

/** Embudo etapa a etapa: negocios que entraron en cada etapa en el periodo, cuántos avanzaron, conversión y días medios. */
export function funnel(ctx: Ctx, g: GlobalFilters = {}) {
  assert(ctx, "deal", "read");
  const p = { from: g.from || new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10), to: `${(g.to || new Date().toISOString()).slice(0, 10)}T23:59:59` };
  const pid = g.pipeline_id || ctx.db.get<{ id: string }>("SELECT id FROM pipelines WHERE workspace_id=? ORDER BY is_default DESC, position LIMIT 1", ctx.ws)?.id;
  if (!pid) return { pipeline_id: null, stages: [], entered: 0, won: 0, win_rate: 0 };
  const stages = ctx.db.all<Row>("SELECT id, name, color, position, kind, probability, expected_days FROM stages WHERE pipeline_id=? ORDER BY kind='open' DESC, position", pid);
  const open = stages.filter((s) => s.kind === "open");
  const won = stages.find((s) => s.kind === "won");
  const d = scope(ctx, "d.owner_id", g);
  const hist = ctx.db.all<Row>(`SELECT h.deal_id, h.to_stage_id, h.entered_at, h.left_at FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE h.workspace_id=? AND d.pipeline_id=? AND d.deleted_at IS NULL AND ${d.sql} ORDER BY h.entered_at`, ctx.ws, pid, ...d.params);
  const pos = new Map(stages.map((s) => [String(s.id), s.kind === "open" ? Number(s.position) : s.kind === "won" ? 9999 : -1]));
  const byDeal = new Map<string, Row[]>(); for (const h of hist) { const k = String(h.deal_id); if (!byDeal.has(k)) byDeal.set(k, []); byDeal.get(k)!.push(h); }
  const out = open.map((s, i) => {
    const entries = hist.filter((h) => h.to_stage_id === s.id && String(h.entered_at) >= p.from && String(h.entered_at) <= p.to);
    const deals = new Set(entries.map((h) => String(h.deal_id)));
    let advanced = 0;
    for (const did of deals) { const first = entries.find((h) => h.deal_id === did)!; if ((byDeal.get(did) ?? []).some((h) => String(h.entered_at) > String(first.entered_at) && (pos.get(String(h.to_stage_id)) ?? -1) > Number(s.position))) advanced++; }
    const durations = entries.map((h) => ((h.left_at ? Date.parse(String(h.left_at)) : Date.now()) - Date.parse(String(h.entered_at))) / 864e5);
    const avgDays = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0;
    return { id: s.id, name: s.name, color: s.color, position: s.position, expected_days: s.expected_days, entered: deals.size, advanced, conversion: deals.size ? Math.round((1000 * advanced) / deals.size) / 10 : 0, avg_days: avgDays, over_expected: avgDays > Number(s.expected_days ?? 0), next: open[i + 1]?.name ?? won?.name ?? "Ganado" };
  });
  const entered = new Set(hist.filter((h) => String(h.entered_at) >= p.from && String(h.entered_at) <= p.to).map((h) => String(h.deal_id)));
  const wonN = won ? new Set(hist.filter((h) => h.to_stage_id === won.id && entered.has(String(h.deal_id))).map((h) => String(h.deal_id))).size : 0;
  return { pipeline_id: pid, stages: out, entered: entered.size, won: wonN, win_rate: entered.size ? Math.round((1000 * wonN) / entered.size) / 10 : 0 };
}

const monthsBetween = (a: string, b: string) => { const out: string[] = []; let [y, m] = a.split("-").map(Number) as [number, number]; const [y2, m2] = b.split("-").map(Number) as [number, number]; while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 36) break; } return out; };
/** Previsión vs real por mes y comercial: comprometido (≥70 %), mejor caso (40–69 %), pipeline (<40 %), ponderado y ganado. */
export function forecast(ctx: Ctx, g: GlobalFilters & { months_back?: number; months_ahead?: number } = {}) {
  assert(ctx, "deal", "read");
  const today = new Date().toISOString().slice(0, 7);
  const shift = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const from = g.from ? g.from.slice(0, 7) : shift(today, -(g.months_back ?? 3));
  const to = g.to ? g.to.slice(0, 7) : shift(today, g.months_ahead ?? 3);
  const months = monthsBetween(from, to);
  const d = scope(ctx, "owner_id", g);
  const pipe = g.pipeline_id ? " AND pipeline_id=?" : ""; const pp = g.pipeline_id ? [g.pipeline_id] : [];
  const openRows = ctx.db.all<Row>(`SELECT owner_id, substr(expected_close_date,1,7) month, SUM(CASE WHEN probability>=70 THEN amount ELSE 0 END) committed, SUM(CASE WHEN probability>=40 AND probability<70 THEN amount ELSE 0 END) best_case, SUM(CASE WHEN probability<40 OR probability IS NULL THEN amount ELSE 0 END) pipeline, SUM(amount*COALESCE(probability,0)/100.0) weighted FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND expected_close_date IS NOT NULL AND substr(expected_close_date,1,7) BETWEEN ? AND ? AND ${d.sql}${pipe} GROUP BY owner_id, month`, ctx.ws, from, to, ...d.params, ...pp);
  const wonRows = ctx.db.all<Row>(`SELECT owner_id, substr(closed_at,1,7) month, SUM(amount) won, COUNT(*) won_count FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND substr(closed_at,1,7) BETWEEN ? AND ? AND ${d.sql}${pipe} GROUP BY owner_id, month`, ctx.ws, from, to, ...d.params, ...pp);
  const names = new Map(ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM users WHERE workspace_id=?", ctx.ws).map((u) => [u.id, u.name]));
  const z = () => ({ committed: 0, best_case: 0, pipeline: 0, weighted: 0, won: 0, won_count: 0, quota: 0 });
  const byMonth = new Map(months.map((m) => [m, { month: m, ...z() }]));
  const byOwner = new Map<string, Row & ReturnType<typeof z>>();
  const own = (o: unknown) => { const k = String(o ?? ""); if (!byOwner.has(k)) byOwner.set(k, { owner_id: o ?? null, name: names.get(k) ?? "Sin propietario", ...z() }); return byOwner.get(k)!; };
  for (const r of openRows) { const m = byMonth.get(String(r.month)); const o = own(r.owner_id); for (const k of ["committed", "best_case", "pipeline", "weighted"] as const) { const v = Math.round(Number(r[k] ?? 0)); if (m) m[k] += v; o[k] += v; } }
  for (const r of wonRows) { const m = byMonth.get(String(r.month)); const o = own(r.owner_id); const v = Math.round(Number(r.won ?? 0)); if (m) { m.won += v; m.won_count += Number(r.won_count); } o.won += v; o.won_count += Number(r.won_count); }
  // cuota por mes (suma de cuotas visibles)
  for (const m of months) { const q = quotaReport(ctx, { ...g, month: m }); const bm = byMonth.get(m)!; bm.quota = q.totals.quota; for (const u of q.users) { if (byOwner.has(String(u.user_id)) || u.quota) own(u.user_id).quota += u.quota; } }
  return { from, to, current: today, months: [...byMonth.values()].map((m) => ({ ...m, past: m.month < today, gap: m.month <= today ? m.won - m.quota : null })), by_owner: [...byOwner.values()].sort((a, b) => b.won + b.committed - (a.won + a.committed)) };
}

/** Cuotas por usuario y mes (tabla user_quotas; si no hay, la cuota mensual del usuario). */
export function quotaReport(ctx: Ctx, g: GlobalFilters & { month?: string } = {}) {
  const month = g.month || new Date().toISOString().slice(0, 7);
  const s = scope(ctx, "u.id", g);
  const users = ctx.db.all<Row>(`SELECT u.id user_id, u.name, COALESCE((SELECT amount FROM user_quotas q WHERE q.user_id=u.id AND q.month=?), u.quota, 0) quota, (SELECT COALESCE(SUM(amount),0) FROM deals d WHERE d.owner_id=u.id AND d.status='won' AND d.deleted_at IS NULL AND substr(d.closed_at,1,7)=?${g.pipeline_id ? " AND d.pipeline_id=?" : ""}) won FROM users u WHERE u.workspace_id=? AND u.active=1 AND COALESCE(u.is_service,0)=0 AND ${s.sql} ORDER BY won DESC`, month, month, ...(g.pipeline_id ? [g.pipeline_id] : []), ctx.ws, ...s.params)
    .map((u) => ({ user_id: String(u.user_id), name: String(u.name), quota: Number(u.quota) || 0, won: Number(u.won) || 0, attainment: Number(u.quota) ? Math.round((1000 * Number(u.won)) / Number(u.quota)) / 10 : null }));
  const totals = { quota: users.reduce((a, u) => a + u.quota, 0), won: users.reduce((a, u) => a + u.won, 0) };
  return { month, users, totals: { ...totals, attainment: totals.quota ? Math.round((1000 * totals.won) / totals.quota) / 10 : null } };
}
export function setQuota(ctx: Ctx, userId: string, month: string, amount: number | null) {
  if (!isAdmin(ctx) && ctx.role.visibility !== "team") throw forbidden("Solo administradores y managers fijan cuotas");
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("Mes no válido (AAAA-MM)");
  const u = ctx.db.get<Row>("SELECT id, team_id FROM users WHERE id=? AND workspace_id=?", userId, ctx.ws); if (!u) throw notFound("Usuario");
  if (!isAdmin(ctx) && !(ownerScope(ctx, "x").params as string[]).includes(userId)) throw forbidden("Ese usuario no es de tu equipo");
  ctx.db.run("DELETE FROM user_quotas WHERE user_id=? AND month=?", userId, month);
  if (amount !== null) ctx.db.insert("user_quotas", { id: id(), workspace_id: ctx.ws, user_id: userId, month, amount, updated_by: ctx.user.id, updated_at: now() });
}

/** Motivos de pérdida agregados con importe, % y competidores más citados. */
export function lossReasons(ctx: Ctx, g: GlobalFilters = {}) {
  assert(ctx, "deal", "read");
  const p = { from: g.from || new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), to: `${(g.to || new Date().toISOString()).slice(0, 10)}T23:59:59` };
  const d = scope(ctx, "owner_id", g);
  const pipe = g.pipeline_id ? " AND pipeline_id=?" : ""; const pp = g.pipeline_id ? [g.pipeline_id] : [];
  const rows = ctx.db.all<Row>(`SELECT loss_reason reason, COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='lost' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe} GROUP BY loss_reason ORDER BY count DESC`, ctx.ws, p.from, p.to, ...d.params, ...pp);
  const total = rows.reduce((a, r) => a + Number(r.count), 0);
  const hasCompetitor = ctx.db.all<{ name: string }>("PRAGMA table_info(deals)").some((c) => c.name === "competitor");
  const competitors = hasCompetitor ? ctx.db.all<Row>(`SELECT competitor name, COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='lost' AND competitor IS NOT NULL AND competitor != '' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe} GROUP BY competitor ORDER BY count DESC LIMIT 10`, ctx.ws, p.from, p.to, ...d.params, ...pp) : [];
  const byOwner = ctx.db.all<Row>(`SELECT owner_id, (SELECT name FROM users WHERE id=owner_id) name, loss_reason reason, COUNT(*) count FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='lost' AND closed_at BETWEEN ? AND ? AND ${d.sql}${pipe} GROUP BY owner_id, loss_reason`, ctx.ws, p.from, p.to, ...d.params, ...pp);
  return { total, reasons: rows.map((r) => ({ reason: r.reason ?? null, label: LOSS_LABELS[String(r.reason)] ?? (r.reason ? String(r.reason) : "Sin motivo"), count: Number(r.count), amount: Number(r.amount), pct: total ? Math.round((1000 * Number(r.count)) / total) / 10 : 0 })), competitors, by_owner: byOwner.map((r) => ({ ...r, label: LOSS_LABELS[String(r.reason)] ?? r.reason ?? "Sin motivo" })) };
}

/* ------------------------------------------------------------------ paneles */
export const widgetSchema = z.object({ id: z.string().min(1).max(40), kind: z.enum(["report", "kpi", "funnel", "forecast", "quota", "loss_reasons"]), report_id: z.string().optional(), kpi: z.string().optional(), title: z.string().max(120).optional(), w: z.number().int().min(2).max(12).default(4), h: z.number().int().min(1).max(4).default(2), chart: z.enum(CHARTS).optional() });
export const dashboardSchema = z.object({ name: z.string().trim().min(1).max(120), visibility: z.enum(["private", "team", "all", "role"]).default("private"), role_key: z.string().nullable().optional(), widgets: z.array(widgetSchema).max(40).default([]), filters: globalSchema.optional(), is_default: z.boolean().optional() });

const DEFAULT_DASHBOARDS: { role: string; name: string; widgets: z.input<typeof widgetSchema>[] }[] = [
  { role: "admin", name: "Dirección", widgets: [{ id: "k1", kind: "kpi", kpi: "won_amount", w: 3, h: 1 }, { id: "k2", kind: "kpi", kpi: "open_pipeline", w: 3, h: 1 }, { id: "k3", kind: "kpi", kpi: "conversion_rate", w: 3, h: 1 }, { id: "k4", kind: "kpi", kpi: "quota_attainment", w: 3, h: 1 }, { id: "f", kind: "forecast", w: 8, h: 2 }, { id: "fu", kind: "funnel", w: 4, h: 2 }, { id: "q", kind: "quota", w: 6, h: 2 }, { id: "l", kind: "loss_reasons", w: 6, h: 2 }] },
  { role: "manager", name: "Equipo comercial", widgets: [{ id: "k1", kind: "kpi", kpi: "won_amount", w: 3, h: 1 }, { id: "k2", kind: "kpi", kpi: "weighted_pipeline", w: 3, h: 1 }, { id: "k3", kind: "kpi", kpi: "activities", w: 3, h: 1 }, { id: "k4", kind: "kpi", kpi: "overdue_tasks", w: 3, h: 1 }, { id: "q", kind: "quota", w: 6, h: 2 }, { id: "fu", kind: "funnel", w: 6, h: 2 }, { id: "f", kind: "forecast", w: 12, h: 2 }] },
  { role: "sales", name: "Mi rendimiento", widgets: [{ id: "k1", kind: "kpi", kpi: "won_amount", w: 4, h: 1 }, { id: "k2", kind: "kpi", kpi: "quota_attainment", w: 4, h: 1 }, { id: "k3", kind: "kpi", kpi: "overdue_tasks", w: 4, h: 1 }, { id: "f", kind: "forecast", w: 8, h: 2 }, { id: "fu", kind: "funnel", w: 4, h: 2 }] },
  { role: "marketing", name: "Captación", widgets: [{ id: "k1", kind: "kpi", kpi: "new_leads", w: 4, h: 1 }, { id: "k2", kind: "kpi", kpi: "conversion_rate", w: 4, h: 1 }, { id: "k3", kind: "kpi", kpi: "activities", w: 4, h: 1 }, { id: "fu", kind: "funnel", w: 6, h: 2 }, { id: "l", kind: "loss_reasons", w: 6, h: 2 }] },
  { role: "support", name: "Soporte", widgets: [{ id: "k1", kind: "kpi", kpi: "open_tickets", w: 4, h: 1 }, { id: "k2", kind: "kpi", kpi: "sla_breached", w: 4, h: 1 }, { id: "k3", kind: "kpi", kpi: "overdue_tasks", w: 4, h: 1 }] },
  { role: "readonly", name: "Resumen", widgets: [{ id: "k1", kind: "kpi", kpi: "won_amount", w: 4, h: 1 }, { id: "k2", kind: "kpi", kpi: "open_pipeline", w: 4, h: 1 }, { id: "k3", kind: "kpi", kpi: "conversion_rate", w: 4, h: 1 }, { id: "fu", kind: "funnel", w: 12, h: 2 }] },
];
/** Un panel predeterminado por rol (se crea la primera vez que alguien entra en Paneles). */
export function ensureDefaultDashboards(ctx: Ctx) {
  if (ctx.db.get("SELECT id FROM dashboards WHERE workspace_id=? AND is_default=1 LIMIT 1", ctx.ws)) return;
  for (const d of DEFAULT_DASHBOARDS) {
    const widgets = d.widgets.map((w) => widgetSchema.parse(w));
    ctx.db.insert("dashboards", { id: id(), workspace_id: ctx.ws, owner_id: null, team_id: null, role_key: d.role, name: d.name, visibility: "role", is_default: 1, widgets, filters: {}, created_at: now(), updated_at: now() });
  }
}
export function listDashboards(ctx: Ctx) {
  ensureDefaultDashboards(ctx);
  const v = visibleSql(ctx, "d");
  return ctx.db.all<Row>(`SELECT d.*, (SELECT name FROM users WHERE id=d.owner_id) owner_name FROM dashboards d WHERE d.workspace_id=? AND ${v.sql} ORDER BY (d.role_key = ?) DESC, d.is_default DESC, d.name`, ctx.ws, ...v.params, ctx.role.key).map((d) => parseJson(d, ["widgets", "filters"]));
}
export function getDashboard(ctx: Ctx, did: string) {
  const v = visibleSql(ctx);
  const d = ctx.db.get<Row>(`SELECT * FROM dashboards WHERE id=? AND workspace_id=? AND ${v.sql}`, did, ctx.ws, ...v.params);
  if (!d) throw notFound("Panel");
  return parseJson(d, ["widgets", "filters"]) as Row;
}
const canEditDashboard = (ctx: Ctx, d: Row) => isAdmin(ctx) || d.owner_id === ctx.user.id;
export function saveDashboard(ctx: Ctx, input: unknown, did?: string) {
  const b = dashboardSchema.parse(input);
  if ((b.visibility === "all" || b.visibility === "role") && !isAdmin(ctx)) throw forbidden("Solo un administrador comparte paneles con todos o por rol");
  if (b.visibility === "team" && !canShare(ctx)) throw forbidden("Tu rol solo permite paneles privados");
  for (const w of b.widgets) if (w.kind === "report" && w.report_id) getReport(ctx, w.report_id);
  if (did) {
    const cur = getDashboard(ctx, did);
    if (!canEditDashboard(ctx, cur)) throw forbidden("Duplica este panel para personalizarlo");
    ctx.db.update("dashboards", did, { name: b.name, visibility: b.visibility, role_key: b.visibility === "role" ? b.role_key ?? cur.role_key ?? null : null, widgets: b.widgets, filters: b.filters ?? {}, team_id: ctx.user.team_id ?? null, updated_at: now() });
    return getDashboard(ctx, did);
  }
  const nid = id();
  ctx.db.insert("dashboards", { id: nid, workspace_id: ctx.ws, owner_id: ctx.user.id, team_id: ctx.user.team_id ?? null, role_key: b.visibility === "role" ? b.role_key ?? null : null, name: b.name, visibility: b.visibility, is_default: 0, widgets: b.widgets, filters: b.filters ?? {}, created_at: now(), updated_at: now() });
  return getDashboard(ctx, nid);
}
export function deleteDashboard(ctx: Ctx, did: string) { const cur = getDashboard(ctx, did); if (!canEditDashboard(ctx, cur)) throw forbidden("No puedes borrar este panel"); ctx.db.run("DELETE FROM dashboards WHERE id=?", did); }
export function duplicateDashboard(ctx: Ctx, did: string) { const cur = getDashboard(ctx, did); return saveDashboard(ctx, { name: `${cur.name} (copia)`, visibility: "private", widgets: cur.widgets, filters: cur.filters }); }

/* ------------------------------------------------------------------ programación y alertas */
export const scheduleSchema = z.object({ report_id: z.string(), frequency: z.enum(["daily", "weekly", "monthly"]), hour: z.number().int().min(0).max(23).default(8), weekday: z.number().int().min(0).max(6).default(1), monthday: z.number().int().min(1).max(28).default(1), recipients: z.array(z.string().email()).min(1).max(20), period_days: z.number().int().min(0).max(366).default(0), active: z.boolean().default(true) });
export const alertSchema = z.object({ name: z.string().trim().min(1).max(120), metric: z.string(), report_id: z.string().nullable().optional(), period: z.enum(["day", "week", "month"]).default("week"), op: z.enum(["lt", "gt", "lte", "gte"]), threshold: z.number(), notify_user_ids: z.array(z.string()).max(20).default([]), active: z.boolean().default(true) });

/** Hora local del espacio (zona horaria de Ajustes). */
export function localNow(tz: string, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: wd, day: Number(parts.day), month: `${parts.year}-${parts.month}` };
}
function periodKey(s: Row, l: ReturnType<typeof localNow>): string | null {
  if (l.hour < Number(s.hour)) return null;
  if (s.frequency === "daily") return l.date;
  if (s.frequency === "weekly") return l.weekday === Number(s.weekday) ? l.date : null;
  return l.day === Number(s.monthday) ? l.month : null;
}
/** Ejecuta un informe programado con la visibilidad de quien lo programó y lo envía por email con el CSV adjunto. */
export async function runSchedule(db: Db, sched: Row): Promise<{ rows: number; recipients: string[] }> {
  const ctx = ctxAs(db, String(sched.created_by)) ?? systemCtx(db, String(sched.workspace_id));
  const rep = getReport(ctx, String(sched.report_id));
  const days = Number(sched.period_days ?? 0);
  const g: GlobalFilters = days ? { from: new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) } : {};
  const res = runReport(ctx, String(rep.object), rep.config, g);
  const csv = toCsv(res);
  const recipients = JSON.parse(String(sched.recipients ?? "[]")) as string[];
  const fmt = (m: ReportResult["metrics"][number], v: unknown) => (m.money ? new Intl.NumberFormat("es-ES", { style: "currency", currency: ctx.settings.currency || "EUR", maximumFractionDigits: 0 }).format(Number(v)) : new Intl.NumberFormat("es-ES").format(Number(v)));
  const top = res.rows.slice(0, 10).map((r) => `<tr>${res.dims.map((d) => `<td>${escHtml(String(r[`${d.key}_label`]))}</td>`).join("")}${res.metrics.map((m) => `<td style="text-align:right">${fmt(m, r[m.key])}</td>`).join("")}</tr>`).join("");
  const html = `<p>Informe programado <b>${escHtml(String(rep.name))}</b>${days ? ` · últimos ${days} días` : ""}.</p><p>${res.metrics.map((m) => `${escHtml(m.label)}: <b>${fmt(m, res.totals[m.key])}</b>`).join(" · ")}</p>${top ? `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr>${[...res.dims.map((d) => d.label), ...res.metrics.map((m) => m.label)].map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr>${top}</table>` : ""}<p>El detalle completo va en el CSV adjunto (${res.rows.length} filas).</p>`;
  const filename = `${String(rep.name).replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, "").trim().replace(/\s+/g, "-") || "informe"}.csv`;
  for (const to of recipients) await sendMail(db, String(sched.workspace_id), { to, subject: `Informe: ${rep.name}`, html, track: false, userId: String(sched.created_by), attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }] });
  db.update("report_schedules", String(sched.id), { last_run_at: now(), last_error: null });
  return { rows: res.rows.length, recipients };
}
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function alertPeriod(p: string, tz: string): GlobalFilters & { key: string } {
  const l = localNow(tz);
  if (p === "day") return { from: l.date, to: l.date, key: l.date };
  if (p === "month") return { from: `${l.month}-01`, to: l.date, key: l.month };
  const d = new Date(`${l.date}T00:00:00Z`); const back = (l.weekday + 6) % 7; d.setUTCDate(d.getUTCDate() - back);
  return { from: d.toISOString().slice(0, 10), to: l.date, key: `W${d.toISOString().slice(0, 10)}` };
}
export function alertValue(ctx: Ctx, a: Row): { value: number; key: string } {
  const p = alertPeriod(String(a.period), ctx.settings.timezone);
  if (a.metric === "report") { const rep = getReport(ctx, String(a.report_id)); const res = runReport(ctx, String(rep.object), rep.config, { from: p.from, to: p.to }); return { value: Number(res.totals.m0 ?? 0), key: p.key }; }
  return { value: kpiValue(ctx, String(a.metric), { from: p.from, to: p.to }), key: p.key };
}
const cmpOp = (op: string, v: number, t: number) => (op === "lt" ? v < t : op === "gt" ? v > t : op === "lte" ? v <= t : v >= t);
/** Evalúa una alerta: si se cumple y no se avisó ya en este periodo, notifica a los destinatarios. */
export function checkAlert(db: Db, a: Row, force = false): { value: number; triggered: boolean } {
  const ctx = ctxAs(db, String(a.created_by)) ?? systemCtx(db, String(a.workspace_id));
  const { value, key } = alertValue(ctx, a);
  const hit = cmpOp(String(a.op), value, Number(a.threshold));
  const already = a.last_triggered_key === key;
  db.update("metric_alerts", String(a.id), { last_value: value, last_checked_at: now() });
  if (hit && (!already || force)) {
    const def = KPIS[String(a.metric)];
    const shown = def?.pct ? `${value} %` : def?.money ? new Intl.NumberFormat("es-ES", { style: "currency", currency: ctx.settings.currency || "EUR", maximumFractionDigits: 0 }).format(value) : String(value);
    const opTxt = { lt: "por debajo de", gt: "por encima de", lte: "≤", gte: "≥" }[String(a.op)];
    const users = (JSON.parse(String(a.notify_user_ids ?? "[]")) as string[]); if (!users.length) users.push(String(a.created_by));
    for (const u of users) notify(db, String(a.workspace_id), u, { type: "metric_alert", title: `Alerta: ${a.name}`, body: `${def?.label ?? "Valor"} = ${shown} (${opTxt} ${a.threshold})`, link: "/analitica?tab=alertas" });
    db.update("metric_alerts", String(a.id), { last_triggered_key: key, last_triggered_at: now() });
    return { value, triggered: true };
  }
  return { value, triggered: false };
}

/** Llamado por el planificador cada minuto: informes programados vencidos y alertas (como mucho una vez por hora). */
export async function runAnalyticsJobs(db: Db, ws: string, tz: string, at = new Date()) {
  const l = localNow(tz, at);
  for (const s of db.all<Row>("SELECT * FROM report_schedules WHERE workspace_id=? AND active=1", ws)) {
    const key = periodKey(s, l);
    if (!key || s.last_period_key === key) continue;
    db.update("report_schedules", String(s.id), { last_period_key: key });
    try { await runSchedule(db, s); } catch (e) { db.update("report_schedules", String(s.id), { last_error: (e as Error).message }); }
  }
  const hourAgo = new Date(at.getTime() - 3600e3).toISOString();
  for (const a of db.all<Row>("SELECT * FROM metric_alerts WHERE workspace_id=? AND active=1 AND (last_checked_at IS NULL OR last_checked_at < ?)", ws, hourAgo)) {
    try { checkAlert(db, a); } catch (e) { db.update("metric_alerts", String(a.id), { last_checked_at: now(), last_error: (e as Error).message }); }
  }
}
