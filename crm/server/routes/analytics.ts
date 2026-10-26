/** Rutas de analítica: constructor de informes, paneles, embudo, previsión, cuotas, motivos de pérdida, programación y alertas. */
import { Router, type Response } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import type { Row } from "../db.js";
import { parseJson } from "../db.js";
import { id, now } from "../lib/util.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { assert, isAdmin } from "../lib/permissions.js";
import { OBJECT_FIELDS } from "../lib/filters.js";
import { fieldDefs } from "../services/columns.js";
import * as A from "../services/analytics.js";

const g = (q: Record<string, unknown>): A.GlobalFilters => {
  const s = (k: string) => (typeof q[k] === "string" && q[k] ? String(q[k]) : undefined);
  return { from: s("from"), to: s("to"), owner_id: s("owner_id"), team_id: s("team_id"), pipeline_id: s("pipeline_id") };
};
const sendCsv = (res: Response, name: string, csv: string) => {
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${name.replace(/[^\w\-]+/g, "-").replace(/-+/g, "-") || "informe"}-${now().slice(0, 10)}.csv"`);
  res.send(csv);
};
const runSchema = z.object({ object: z.enum(A.REPORT_OBJECTS), config: z.unknown(), global: A.globalSchema.optional() });

export function analyticsRoutes() {
  const r = Router();

  /* ---- metadatos para el constructor ---- */
  r.get("/meta", h(async (req) => {
    const objects = Object.fromEntries(A.REPORT_OBJECTS.map((o) => {
      const base = Object.entries(OBJECT_FIELDS[o] ?? {}).filter(([, k]) => k !== "json").map(([f, k]) => ({ field: f, label: A.FIELD_LABELS[f] ?? f, kind: k === "bool" ? "text" : k }));
      const custom = o === "activity" ? [] : fieldDefs(req.ctx, o).filter((d) => !["button", "mirror", "formula", "autonumber", "creation_log", "last_updated", "timeline", "multiselect"].includes(d.type) || (d.type === "formula" && false)).map((d) => ({ field: `custom.${d.key}`, label: d.label, kind: ["number", "currency", "percent", "rating"].includes(d.type) ? "number" : ["date", "datetime"].includes(d.type) ? "date" : "text" }));
      return [o, { fields: [...base, ...custom], date_field: A.DATE_FIELD[o] }];
    }));
    return { objects, kpis: A.KPIS, buckets: A.BUCKETS, metrics: A.METRIC_FNS, charts: A.CHARTS };
  }));

  /* ---- ejecución ad hoc ---- */
  r.post("/run", h(async (req) => { const b = parse(runSchema, req.body); return A.runReport(req.ctx, b.object, b.config, b.global ?? {}); }));
  r.get("/run.csv", h(async (req, res) => {
    const object = String(req.query.object ?? ""); let config: unknown;
    try { config = JSON.parse(String(req.query.config ?? "{}")); } catch { throw badRequest("Configuración no válida"); }
    assert(req.ctx, A.REPORT_OBJECTS.includes(object as never) && object !== "activity" ? object : "report", "export");
    sendCsv(res, String(req.query.name ?? "informe"), A.toCsv(A.runReport(req.ctx, object, config, g(req.query as never))));
  }));

  /* ---- informes guardados ---- */
  r.get("/reports", h(async (req) => ({ items: A.listReports(req.ctx) })));
  r.post("/reports", h(async (req) => A.saveReport(req.ctx, req.body)));
  r.get("/reports/:id", h(async (req) => A.getReport(req.ctx, param(req, "id"))));
  r.put("/reports/:id", h(async (req) => A.saveReport(req.ctx, req.body, param(req, "id"))));
  r.delete("/reports/:id", h(async (req) => { A.deleteReport(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/reports/:id/duplicate", h(async (req) => A.duplicateReport(req.ctx, param(req, "id"))));
  r.post("/reports/:id/run", h(async (req) => { const rep = A.getReport(req.ctx, param(req, "id")); const gl = parse(A.globalSchema, req.body?.global ?? {}); return { report: rep, result: A.runReport(req.ctx, String(rep.object), rep.config, gl) }; }));
  r.get("/reports/:id/export.csv", h(async (req, res) => {
    const rep = A.getReport(req.ctx, param(req, "id"));
    assert(req.ctx, rep.object === "activity" ? "report" : String(rep.object), "export");
    sendCsv(res, String(rep.name), A.toCsv(A.runReport(req.ctx, String(rep.object), rep.config, g(req.query as never))));
  }));

  /* ---- KPIs y analítica comercial ---- */
  r.get("/kpi/:key", h(async (req) => A.kpi(req.ctx, param(req, "key"), g(req.query as never))));
  r.get("/funnel", h(async (req) => A.funnel(req.ctx, g(req.query as never))));
  r.get("/forecast", h(async (req) => A.forecast(req.ctx, { ...g(req.query as never), months_back: req.query.months_back ? Number(req.query.months_back) : undefined, months_ahead: req.query.months_ahead ? Number(req.query.months_ahead) : undefined })));
  r.get("/quota", h(async (req) => A.quotaReport(req.ctx, { ...g(req.query as never), month: typeof req.query.month === "string" ? req.query.month : undefined })));
  r.put("/quota", h(async (req) => { const b = parse(z.object({ user_id: z.string(), month: z.string(), amount: z.number().min(0).nullable() }), req.body); A.setQuota(req.ctx, b.user_id, b.month, b.amount); return A.quotaReport(req.ctx, { month: b.month }); }));
  r.get("/loss-reasons", h(async (req) => A.lossReasons(req.ctx, g(req.query as never))));

  /* ---- paneles ---- */
  r.get("/dashboards", h(async (req) => ({ items: A.listDashboards(req.ctx) })));
  r.post("/dashboards", h(async (req) => A.saveDashboard(req.ctx, req.body)));
  r.get("/dashboards/:id", h(async (req) => A.getDashboard(req.ctx, param(req, "id"))));
  r.put("/dashboards/:id", h(async (req) => A.saveDashboard(req.ctx, req.body, param(req, "id"))));
  r.delete("/dashboards/:id", h(async (req) => { A.deleteDashboard(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/dashboards/:id/duplicate", h(async (req) => A.duplicateDashboard(req.ctx, param(req, "id"))));

  /* ---- informes programados ---- */
  const schedRow = (s: Row) => parseJson(s, ["recipients"]);
  const mineSql = (admin: boolean) => (admin ? "1=1" : "s.created_by = ?");
  r.get("/schedules", h(async (req) => ({ items: req.ctx.db.all<Row>(`SELECT s.*, r.name report_name, (SELECT name FROM users WHERE id=s.created_by) created_by_name FROM report_schedules s LEFT JOIN saved_reports r ON r.id=s.report_id WHERE s.workspace_id=? AND ${mineSql(isAdmin(req.ctx))} ORDER BY s.created_at DESC`, req.ctx.ws, ...(isAdmin(req.ctx) ? [] : [req.ctx.user.id])).map(schedRow) })));
  r.post("/schedules", h(async (req) => {
    const b = parse(A.scheduleSchema, req.body); A.getReport(req.ctx, b.report_id);
    const sid = id(); req.ctx.db.insert("report_schedules", { id: sid, workspace_id: req.ctx.ws, report_id: b.report_id, created_by: req.ctx.user.id, frequency: b.frequency, hour: b.hour, weekday: b.weekday, monthday: b.monthday, recipients: b.recipients, period_days: b.period_days, active: b.active ? 1 : 0, created_at: now() });
    return schedRow(req.ctx.db.get<Row>("SELECT * FROM report_schedules WHERE id=?", sid)!);
  }));
  const ownSched = (req: any) => { const s = req.ctx.db.get("SELECT * FROM report_schedules WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws) as Row | undefined; if (!s) throw notFound("Programación"); if (s.created_by !== req.ctx.user.id && !isAdmin(req.ctx)) throw forbidden("No es tuya"); return s; };
  r.put("/schedules/:id", h(async (req) => { const s = ownSched(req); const b = parse(A.scheduleSchema.partial(), req.body); req.ctx.db.update("report_schedules", String(s.id), { ...b, recipients: b.recipients, active: b.active === undefined ? undefined : b.active ? 1 : 0, last_period_key: null }); return schedRow(req.ctx.db.get<Row>("SELECT * FROM report_schedules WHERE id=?", s.id)!); }));
  r.delete("/schedules/:id", h(async (req) => { const s = ownSched(req); req.ctx.db.run("DELETE FROM report_schedules WHERE id=?", s.id); return { ok: true }; }));
  r.post("/schedules/:id/run", h(async (req) => { const s = ownSched(req); return A.runSchedule(req.ctx.db, s); }));

  /* ---- alertas de métricas ---- */
  r.get("/alerts", h(async (req) => ({ items: req.ctx.db.all<Row>(`SELECT s.* FROM metric_alerts s WHERE s.workspace_id=? AND ${mineSql(isAdmin(req.ctx))} ORDER BY s.created_at DESC`, req.ctx.ws, ...(isAdmin(req.ctx) ? [] : [req.ctx.user.id])).map((a) => parseJson(a, ["notify_user_ids"])) })));
  const checkMetric = (req: any, b: { metric: string; report_id?: string | null }) => { if (b.metric === "report") { if (!b.report_id) throw badRequest("Elige el informe"); A.getReport(req.ctx, b.report_id); } else if (!A.KPIS[b.metric]) throw badRequest("Métrica desconocida"); };
  r.post("/alerts", h(async (req) => {
    const b = parse(A.alertSchema, req.body); checkMetric(req, b);
    const aid = id(); req.ctx.db.insert("metric_alerts", { id: aid, workspace_id: req.ctx.ws, created_by: req.ctx.user.id, name: b.name, metric: b.metric, report_id: b.report_id ?? null, period: b.period, op: b.op, threshold: b.threshold, notify_user_ids: b.notify_user_ids, active: b.active ? 1 : 0, created_at: now() });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM metric_alerts WHERE id=?", aid)!, ["notify_user_ids"]);
  }));
  const ownAlert = (req: any) => { const a = req.ctx.db.get("SELECT * FROM metric_alerts WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws) as Row | undefined; if (!a) throw notFound("Alerta"); if (a.created_by !== req.ctx.user.id && !isAdmin(req.ctx)) throw forbidden("No es tuya"); return a; };
  r.put("/alerts/:id", h(async (req) => { const a = ownAlert(req); const b = parse(A.alertSchema.partial(), req.body); if (b.metric) checkMetric(req, { metric: b.metric, report_id: b.report_id ?? (a.report_id as string) }); req.ctx.db.update("metric_alerts", String(a.id), { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0, last_triggered_key: null }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM metric_alerts WHERE id=?", a.id)!, ["notify_user_ids"]); }));
  r.delete("/alerts/:id", h(async (req) => { const a = ownAlert(req); req.ctx.db.run("DELETE FROM metric_alerts WHERE id=?", a.id); return { ok: true }; }));
  r.post("/alerts/:id/check", h(async (req) => { const a = ownAlert(req); return A.checkAlert(req.ctx.db, a, req.body?.force === true); }));
  return r;
}
