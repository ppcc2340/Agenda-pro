import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { workflowSchema, simulate, runWorkflow, loadRecord, TRIGGER_TYPES, ACTION_TYPES, TRIGGER_INFO, ACTION_INFO, planWorkflow, monthUsage, budgetExceeded, decideApproval, serviceUserId } from "../services/workflows.js";
import { RECIPES, installRecipe } from "../services/recipes.js";
import { RELATIONS } from "../services/columns.js";
import { assertAdmin } from "../lib/permissions.js";
import { id, now } from "../lib/util.js";
import { notFound, badRequest, conflict, HttpError } from "../lib/errors.js";
import { parseJson, type Row } from "../db.js";
import { audit } from "../services/audit.js";
import type { Ctx } from "../context.js";

const J = ["trigger", "conditions", "actions"];
const load = (ctx: Ctx, wid: string) => parseJson(ctx.db.get<Row>("SELECT w.*, u.name owner_name FROM workflows w LEFT JOIN users u ON u.id=w.owner_id WHERE w.id=? AND w.workspace_id=?", wid, ctx.ws), J);
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
function guardBudget(ctx: Ctx) { if (budgetExceeded(ctx) && ctx.settings.automation_budget_mode !== "pause_all") throw conflict(`Se ha agotado el presupuesto mensual de ${ctx.settings.automation_budget} acciones: las automatizaciones existentes siguen funcionando, pero no se pueden crear ni editar hasta el mes que viene o hasta ampliar el presupuesto en Ajustes`); }

export function workflowRoutes() {
  const r = Router();
  r.get("/meta", h(async (req) => ({ triggers: TRIGGER_TYPES, actions: ACTION_TYPES, trigger_info: TRIGGER_INFO, action_info: ACTION_INFO, relations: Object.fromEntries(Object.entries(RELATIONS).map(([o, rs]) => [o, Object.entries(rs).map(([k, v]) => ({ key: k, label: v.label, target: v.target, many: v.many }))])), service_user_id: serviceUserId(req.ctx), budget: req.ctx.settings.automation_budget, used: monthUsage(req.ctx) })));
  r.get("/", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT w.*, u.name owner_name, (SELECT COUNT(*) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.status='error') errors, (SELECT COALESCE(SUM(actions_count),0) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.ran_at >= ?) month_actions FROM workflows w LEFT JOIN users u ON u.id=w.owner_id WHERE w.workspace_id=? ORDER BY w.active DESC, w.priority, w.name", monthStart(), req.ctx.ws).map((w) => parseJson(w, J)) })));
  r.post("/", h(async (req) => {
    assertAdmin(req.ctx); guardBudget(req.ctx);
    const b = parse(workflowSchema, req.body);
    const wid = id();
    req.ctx.db.insert("workflows", { id: wid, workspace_id: req.ctx.ws, name: b.name, description: b.description ?? null, trigger: b.trigger, conditions: b.conditions, actions: b.actions, active: b.active === false ? 0 : 1, allow_reenroll: b.allow_reenroll ? 1 : 0, owner_id: b.owner_id ?? null, priority: b.priority ?? 100, atomic: b.atomic ? 1 : 0, review_at: b.review_at ?? null, created_by: req.ctx.user.id, created_at: now(), updated_at: now() });
    audit(req.ctx, "workflow", wid, "create", { name: b.name });
    const w = load(req.ctx, wid)!; const planned = planWorkflow(req.ctx, w);
    return { ...w, planned };
  }));
  // ---------- gobierno: catálogo, uso, historial global ----------
  r.get("/catalog", h(async (req) => {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const items = req.ctx.db.all<Row>(`SELECT w.id, w.name, w.description, w.trigger, w.actions, w.active, w.paused_reason, w.priority, w.review_at, w.recipe, w.last_run_at, w.created_at, w.owner_id, COALESCE(u.name, 'Automatizaciones') owner_name, COALESCE(u.active, 1) owner_active,
      (SELECT COALESCE(SUM(actions_count),0) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.ran_at >= ?) month_actions,
      (SELECT COALESCE(SUM(actions_count),0) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.ran_at >= ?) last30_actions,
      (SELECT COUNT(*) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.ran_at >= ? AND x.status='error') errors30,
      (SELECT COUNT(*) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.ran_at >= ? AND x.status IN ('ok','waiting')) runs30,
      (SELECT COUNT(*) FROM automation_schedule s WHERE s.workflow_id=w.id AND s.fired_at IS NULL) scheduled
      FROM workflows w LEFT JOIN users u ON u.id=w.owner_id WHERE w.workspace_id=? ORDER BY w.priority, w.name`, monthStart(), since30, since30, since30, req.ctx.ws).map((w) => parseJson(w, ["trigger", "actions"]) as Row);
    return { items: items.map((w) => ({ ...w, board: (w.trigger as Row).object ?? null, actions_per_run: (w.actions as unknown[]).length, estimate_month: Number(w.last30_actions) })) };
  }));
  r.get("/usage", h(async (req) => {
    const ms = monthStart();
    const byWf = req.ctx.db.all<Row>("SELECT w.id, w.name, json_extract(w.trigger,'$.object') board, COALESCE(SUM(x.actions_count),0) actions, COUNT(x.id) runs FROM workflows w LEFT JOIN workflow_runs x ON x.workflow_id=w.id AND x.ran_at >= ? WHERE w.workspace_id=? GROUP BY w.id ORDER BY actions DESC", ms, req.ctx.ws);
    const byBoard: Record<string, number> = {}; for (const x of byWf) byBoard[String(x.board ?? "otros")] = (byBoard[String(x.board ?? "otros")] ?? 0) + Number(x.actions);
    const daily = req.ctx.db.all<Row>("SELECT substr(ran_at,1,10) day, COALESCE(SUM(actions_count),0) actions FROM workflow_runs WHERE workspace_id=? AND ran_at >= ? GROUP BY day ORDER BY day", req.ctx.ws, ms);
    const used = monthUsage(req.ctx); const budget = req.ctx.settings.automation_budget;
    const dayOfMonth = new Date().getUTCDate(); const days = new Date(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0).getDate();
    return { used, budget, mode: req.ctx.settings.automation_budget_mode, pct: budget ? Math.round((100 * used) / budget) : 0, projection: Math.round((used / Math.max(1, dayOfMonth)) * days), by_workflow: byWf, by_board: byBoard, daily, exceeded: budgetExceeded(req.ctx) };
  }));
  const runsQuery = (req: { ctx: Ctx; query: Record<string, unknown> }) => {
    const where = ["x.workspace_id=?"]; const p: unknown[] = [req.ctx.ws];
    for (const k of ["workflow_id", "record_id", "status", "object"]) if (typeof req.query[k] === "string" && req.query[k]) { where.push(`x.${k}=?`); p.push(req.query[k]); }
    if (typeof req.query.from === "string" && req.query.from) { where.push("x.ran_at >= ?"); p.push(req.query.from); }
    return req.ctx.db.all<Row>(`SELECT x.*, w.name workflow_name FROM workflow_runs x LEFT JOIN workflows w ON w.id=x.workflow_id WHERE ${where.join(" AND ")} ORDER BY x.ran_at DESC LIMIT ?`, ...p, Math.min(2000, Number(req.query.limit ?? 200))).map((x) => parseJson(x, ["log"]) as Row);
  };
  r.get("/runs", h(async (req) => ({ items: runsQuery(req as never) })));
  r.get("/runs.csv", (req, res, next) => {
    try {
      const items = runsQuery(req as never);
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = items.map((x) => [x.ran_at, x.workflow_name, x.trigger_desc, x.object, x.record_id, x.status, x.actions_count, x.origin, x.depth, x.duration_ms, x.error, (x.log as string[]).join(" | ")].map(esc).join(";"));
      res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="historial-automatizaciones-${now().slice(0, 10)}.csv"`);
      res.send("﻿" + ["fecha", "automatización", "disparador", "objeto", "registro", "estado", "acciones", "origen", "profundidad", "ms", "error", "registro de ejecución"].join(";") + "\n" + rows.join("\n"));
    } catch (e) { next(e); }
  });
  r.get("/record/:object/:rid", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT x.*, w.name workflow_name FROM workflow_runs x LEFT JOIN workflows w ON w.id=x.workflow_id WHERE x.workspace_id=? AND x.object=? AND x.record_id=? ORDER BY x.ran_at DESC LIMIT 100", req.ctx.ws, param(req, "object"), param(req, "rid")).map((x) => parseJson(x, ["log"])), scheduled: req.ctx.db.all<Row>("SELECT s.*, w.name workflow_name FROM automation_schedule s JOIN workflows w ON w.id=s.workflow_id WHERE s.workspace_id=? AND s.record_id=? AND s.fired_at IS NULL ORDER BY s.fire_at", req.ctx.ws, param(req, "rid")) })));
  r.get("/dependents", h(async (req) => { const f = String(req.query.field ?? ""); if (!f) throw badRequest("Indica field"); return { items: req.ctx.db.all<Row>("SELECT id, name FROM workflows WHERE workspace_id=? AND (trigger LIKE ? OR conditions LIKE ? OR actions LIKE ?)", req.ctx.ws, `%"${f}"%`, `%"${f}"%`, `%"${f}"%`) }; }));
  // ---------- aprobaciones (human in the loop) ----------
  r.get("/approvals", h(async (req) => ({ items: req.ctx.db.all<Row>(`SELECT a.*, w.name workflow_name, u.name approver_name FROM automation_approvals a LEFT JOIN workflows w ON w.id=a.workflow_id LEFT JOIN users u ON u.id=a.approver_id WHERE a.workspace_id=? ${req.query.all === "1" && req.ctx.role.permissions.admin ? "" : "AND (a.approver_id=? OR a.approver_id IS NULL)"} ORDER BY a.status='pending' DESC, a.created_at DESC LIMIT 200`, ...(req.query.all === "1" && req.ctx.role.permissions.admin ? [req.ctx.ws] : [req.ctx.ws, req.ctx.user.id])).map((x) => { const y = parseJson(x, ["payload"]) as Row; delete y.payload; return y; }) })));
  r.post("/approvals/:id/decide", h(async (req) => { const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(1000).nullable().optional() }), req.body); try { return decideApproval(req.ctx, param(req, "id"), b.decision, b.comment); } catch (e) { if (e instanceof HttpError) throw e; throw badRequest((e as Error).message); } }));
  // ---------- recetas ----------
  r.get("/recipes", h(async (req) => ({ items: RECIPES.map((x) => ({ code: x.code, title: x.title, description: x.description, category: x.category, estimate: x.estimate, fields: (x.fields ?? []).map((f) => `${f.label} (${f.object})`), workflows: x.workflows.length, installed: req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM workflows WHERE workspace_id=? AND recipe=?", req.ctx.ws, x.code)?.n ?? 0 })) })));
  r.post("/recipes/:code/install", h(async (req) => { assertAdmin(req.ctx); guardBudget(req.ctx); const out = installRecipe(req.ctx, param(req, "code"), { active: req.body?.active !== false }); audit(req.ctx, "workflow", null, "install_recipe", out); return out; }));
  // ---------- propietarios ----------
  r.post("/reassign", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ from: z.string().nullable(), to: z.string().nullable(), reactivate: z.boolean().optional() }), req.body);
    const to = b.to ?? null;
    if (to && !req.ctx.db.get("SELECT id FROM users WHERE id=? AND workspace_id=? AND active=1", to, req.ctx.ws)) throw badRequest("El nuevo propietario no está activo");
    const where = b.from ? "owner_id=?" : "owner_id IS NULL"; const p = b.from ? [b.from] : [];
    const n = req.ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM workflows WHERE workspace_id=? AND ${where}`, req.ctx.ws, ...p)?.n ?? 0;
    req.ctx.db.run(`UPDATE workflows SET owner_id=?, updated_at=?${b.reactivate ? ", active=1, paused_reason=NULL" : ""} WHERE workspace_id=? AND ${where}`, to, now(), req.ctx.ws, ...p);
    audit(req.ctx, "workflow", null, "reassign_owner", { from: b.from, to, count: n });
    return { updated: n };
  }));
  r.post("/simulate", h(async (req) => { const b = parse(z.object({ workflow: workflowSchema, object: z.string(), record_id: z.string() }), req.body); return simulate(req.ctx, b.workflow, b.object, b.record_id); }));
  // ---------- por automatización ----------
  r.get("/:id", h(async (req) => { const w = load(req.ctx, param(req, "id")); if (!w) throw notFound("Automatización"); return w; }));
  r.put("/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(workflowSchema.partial(), req.body);
    const w = req.ctx.db.get<Row>("SELECT id FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!w) throw notFound("Automatización");
    const onlyPause = Object.keys(b).length === 1 && b.active === false;
    if (!onlyPause) guardBudget(req.ctx);
    req.ctx.db.update("workflows", w.id as string, { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0, paused_reason: b.active ? null : undefined, allow_reenroll: b.allow_reenroll === undefined ? undefined : b.allow_reenroll ? 1 : 0, atomic: b.atomic === undefined ? undefined : b.atomic ? 1 : 0, updated_at: now() });
    audit(req.ctx, "workflow", w.id as string, "update", { active: b.active, name: b.name });
    const full = load(req.ctx, String(w.id))!; const planned = planWorkflow(req.ctx, full);
    return { ...full, planned };
  }));
  r.post("/:id/duplicate", h(async (req) => { assertAdmin(req.ctx); guardBudget(req.ctx); const w = load(req.ctx, param(req, "id")); if (!w) throw notFound("Automatización"); const wid = id(); req.ctx.db.insert("workflows", { id: wid, workspace_id: req.ctx.ws, name: `${w.name} (copia)`, description: w.description, trigger: w.trigger, conditions: w.conditions, actions: w.actions, active: 0, allow_reenroll: w.allow_reenroll, owner_id: w.owner_id, priority: w.priority, atomic: w.atomic, created_by: req.ctx.user.id, created_at: now(), updated_at: now() }); return load(req.ctx, wid); }));
  r.delete("/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("DELETE FROM workflow_runs WHERE workflow_id=?", param(req, "id")); req.ctx.db.run("DELETE FROM automation_schedule WHERE workflow_id=?", param(req, "id")); req.ctx.db.run("DELETE FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); audit(req.ctx, "workflow", param(req, "id"), "delete", {}); return { ok: true }; }));
  r.get("/:id/runs", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM workflow_runs WHERE workflow_id=? AND workspace_id=? ORDER BY ran_at DESC LIMIT 200", param(req, "id"), req.ctx.ws).map((x) => parseJson(x, ["log"])) })));
  r.get("/:id/schedule", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM automation_schedule WHERE workflow_id=? AND workspace_id=? AND fired_at IS NULL ORDER BY fire_at LIMIT 200", param(req, "id"), req.ctx.ws) })));
  r.post("/:id/run", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ object: z.string(), record_id: z.string() }), req.body);
    const w = load(req.ctx, param(req, "id")); if (!w) throw notFound("Automatización");
    const record = loadRecord(req.ctx, b.object, b.record_id); if (!record) throw badRequest("Registro no encontrado");
    runWorkflow(req.ctx, w, record, { type: `${b.object}.manual`, object: b.object as never, record, meta: { origin: "manual" } }, { force: true });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY ran_at DESC LIMIT 1", w.id), ["log"]);
  }));
  return r;
}
