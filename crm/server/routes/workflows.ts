import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { workflowSchema, simulate, runWorkflow, loadRecord, TRIGGER_TYPES, ACTION_TYPES } from "../services/workflows.js";
import { assertAdmin } from "../lib/permissions.js";
import { id, now } from "../lib/util.js";
import { notFound, badRequest } from "../lib/errors.js";
import { parseJson, type Row } from "../db.js";
import { audit } from "../services/audit.js";

export function workflowRoutes() {
  const r = Router();
  r.get("/meta", h(async () => ({ triggers: TRIGGER_TYPES, actions: ACTION_TYPES })));
  r.get("/", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT w.*, (SELECT COUNT(*) FROM workflow_runs x WHERE x.workflow_id=w.id AND x.status='error') errors FROM workflows w WHERE workspace_id=? ORDER BY active DESC, name", req.ctx.ws).map((w) => parseJson(w, ["trigger", "conditions", "actions"])) })));
  r.post("/", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(workflowSchema, req.body);
    const wid = id();
    req.ctx.db.insert("workflows", { id: wid, workspace_id: req.ctx.ws, name: b.name, description: b.description ?? null, trigger: b.trigger, conditions: b.conditions, actions: b.actions, active: b.active === false ? 0 : 1, allow_reenroll: b.allow_reenroll ? 1 : 0, created_by: req.ctx.user.id, created_at: now(), updated_at: now() });
    audit(req.ctx, "workflow", wid, "create", { name: b.name });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM workflows WHERE id=?", wid), ["trigger", "conditions", "actions"]);
  }));
  r.get("/:id", h(async (req) => { const w = parseJson(req.ctx.db.get<Row>("SELECT * FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws), ["trigger", "conditions", "actions"]); if (!w) throw notFound("Workflow"); return w; }));
  r.put("/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(workflowSchema.partial(), req.body);
    const w = req.ctx.db.get<Row>("SELECT id FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!w) throw notFound("Workflow");
    req.ctx.db.update("workflows", w.id as string, { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0, allow_reenroll: b.allow_reenroll === undefined ? undefined : b.allow_reenroll ? 1 : 0, updated_at: now() });
    audit(req.ctx, "workflow", w.id as string, "update", { active: b.active });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM workflows WHERE id=?", w.id), ["trigger", "conditions", "actions"]);
  }));
  r.delete("/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("DELETE FROM workflow_runs WHERE workflow_id=?", param(req, "id")); req.ctx.db.run("DELETE FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  r.get("/:id/runs", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM workflow_runs WHERE workflow_id=? AND workspace_id=? ORDER BY ran_at DESC LIMIT 100", param(req, "id"), req.ctx.ws).map((x) => parseJson(x, ["log"])) })));
  r.post("/simulate", h(async (req) => { const b = parse(z.object({ workflow: workflowSchema, object: z.string(), record_id: z.string() }), req.body); return simulate(req.ctx, b.workflow, b.object, b.record_id); }));
  r.post("/:id/run", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ object: z.string(), record_id: z.string() }), req.body);
    const w = parseJson(req.ctx.db.get<Row>("SELECT * FROM workflows WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws), ["trigger", "conditions", "actions"]);
    if (!w) throw notFound("Workflow");
    const record = loadRecord(req.ctx, b.object, b.record_id);
    if (!record) throw badRequest("Registro no encontrado");
    runWorkflow(req.ctx, w, record, { type: `${b.object}.manual`, object: b.object as never, record }, { force: true });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY ran_at DESC LIMIT 1", w.id), ["log"]);
  }));
  return r;
}
