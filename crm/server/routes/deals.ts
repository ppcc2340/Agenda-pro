import { enrichOne } from "../services/columns.js";
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { dealSchema, listDeals, getDeal, createDeal, updateDeal, deleteDeal, restoreDeal, moveStage, closeDeal, closeSchema, reopenDeal, setDealProducts, lineSchema, board, forecast, LOSS_REASONS } from "../services/deals.js";
import { listQuery } from "../services/records.js";
import { timeline } from "../services/activities.js";
import { assert, assertAdmin } from "../lib/permissions.js";
import { toCsv, id, now } from "../lib/util.js";
import { audit } from "../services/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import type { Row } from "../db.js";
import { parseJson } from "../db.js";
import { visibleColumns, redactAll, assertWritable } from "../services/fieldSecurity.js";

export function dealRoutes() {
  const r = Router();
  r.get("/", h(async (req) => listDeals(req.ctx, parse(listQuery, req.query), typeof req.query.pipeline_id === "string" && req.query.pipeline_id ? req.query.pipeline_id : undefined)));
  r.get("/board/:pipelineId", h(async (req) => board(req.ctx, param(req, "pipelineId"), { filters: req.query.filters, owner_id: typeof req.query.owner_id === "string" ? req.query.owner_id : undefined, q: typeof req.query.q === "string" ? req.query.q : undefined })));
  r.get("/forecast", h(async (req) => ({ months: forecast(req.ctx, typeof req.query.pipeline_id === "string" ? req.query.pipeline_id : undefined) })));
  r.get("/loss-reasons", h(async () => ({ items: LOSS_REASONS })));
  r.get("/export", h(async (req, res) => {
    assert(req.ctx, "deal", "export");
    const q = parse(listQuery, { ...req.query, page: 1, page_size: 500 });
    const all: Row[] = [];
    for (let page = 1; page <= 200; page++) { const r2 = listDeals(req.ctx, { ...q, page }); all.push(...r2.items); if (r2.items.length < q.page_size) break; }
    audit(req.ctx, "deal", null, "export", { count: all.length });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="negocios-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + toCsv(all, visibleColumns(req.ctx, "deal", ["id", "name", "company_name", "pipeline_name", "stage_name", "status", "amount", "currency", "probability", "weighted_amount", "expected_close_date", "closed_at", "loss_reason", "owner_name", "source", "created_at", "last_activity_at"])));
  }));
  r.post("/", h(async (req) => createDeal(req.ctx, parse(dealSchema, req.body))));
  r.get("/:id", h(async (req) => {
    const d = getDeal(req.ctx, param(req, "id"))
    enrichOne(req.ctx, "deal", d);
    const db = req.ctx.db;
    return { ...d, tasks: db.all("SELECT t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name FROM tasks t WHERE t.deal_id=? AND t.completed_at IS NULL ORDER BY t.due_at", d.id), quotes: db.all("SELECT id, number, version, status, total, date, valid_until, views, token FROM quotes WHERE deal_id=? ORDER BY created_at DESC", d.id) };
  }));
  r.get("/:id/timeline", h(async (req) => ({ items: timeline(req.ctx, { deal_id: param(req, "id") }, typeof req.query.types === "string" && req.query.types ? req.query.types.split(",") : undefined) })));
  r.get("/:id/history", h(async (req) => ({ items: req.ctx.db.all("SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.object='deal' AND a.record_id=? ORDER BY a.created_at DESC LIMIT 200", param(req, "id")).map((x) => ({ ...x, changes: JSON.parse(String(x.changes || "{}")) })) })));
  r.put("/:id", h(async (req) => updateDeal(req.ctx, param(req, "id"), parse(dealSchema.partial(), req.body))));
  r.patch("/:id", h(async (req) => updateDeal(req.ctx, param(req, "id"), parse(dealSchema.partial(), req.body))));
  r.post("/:id/stage", h(async (req) => moveStage(req.ctx, param(req, "id"), parse(z.object({ stage_id: z.string() }), req.body).stage_id)));
  r.post("/:id/close", h(async (req) => closeDeal(req.ctx, param(req, "id"), parse(closeSchema, req.body))));
  r.post("/:id/reopen", h(async (req) => reopenDeal(req.ctx, param(req, "id"))));
  r.put("/:id/products", h(async (req) => setDealProducts(req.ctx, param(req, "id"), parse(z.array(lineSchema), req.body))));
  r.delete("/:id", h(async (req) => { deleteDeal(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/:id/restore", h(async (req) => { restoreDeal(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/bulk", h(async (req) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1), action: z.enum(["update", "delete", "stage"]), patch: dealSchema.partial().optional(), stage_id: z.string().optional() }), req.body);
    let n = 0;
    for (const did of b.ids) { try { if (b.action === "delete") deleteDeal(req.ctx, did); else if (b.action === "stage" && b.stage_id) moveStage(req.ctx, did, b.stage_id); else if (b.patch) updateDeal(req.ctx, did, b.patch); n++; } catch (e) { console.warn("[bulk]", (e as Error).message); } }
    return { ok: true, affected: n };
  }));
  return r;
}

const stageSchema = z.object({ name: z.string().trim().min(1).max(100), probability: z.number().int().min(0).max(100).optional(), color: z.string().max(20).optional(), expected_days: z.number().int().min(1).max(365).optional(), required_fields: z.array(z.string()).optional(), kind: z.enum(["open", "won", "lost"]).optional() });

export function pipelineRoutes() {
  const r = Router();
  r.get("/", h(async (req) => {
    const pipelines = req.ctx.db.all<Row>("SELECT * FROM pipelines WHERE workspace_id=? ORDER BY position, created_at", req.ctx.ws);
    for (const p of pipelines) p.stages = req.ctx.db.all<Row>("SELECT * FROM stages WHERE pipeline_id=? ORDER BY position", p.id).map((s) => parseJson(s, ["required_fields"]));
    return { items: pipelines };
  }));
  r.post("/", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), stages: z.array(stageSchema).optional() }), req.body);
    const pid = id();
    const pos = (req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM pipelines WHERE workspace_id=?", req.ctx.ws)?.n ?? 0);
    req.ctx.db.insert("pipelines", { id: pid, workspace_id: req.ctx.ws, name: b.name, position: pos, is_default: pos === 0 ? 1 : 0, created_at: now() });
    const stages = b.stages?.length ? b.stages : [{ name: "Cualificación", probability: 10, color: "#74869A", expected_days: 7 }, { name: "Contacto", probability: 25, color: "#3A6EDB", expected_days: 10 }, { name: "Propuesta", probability: 50, color: "#B07414", expected_days: 14 }, { name: "Negociación", probability: 75, color: "#B0407E", expected_days: 10 }];
    stages.forEach((s, i) => req.ctx.db.insert("stages", { id: id(), workspace_id: req.ctx.ws, pipeline_id: pid, name: s.name, position: i, probability: s.probability ?? 10, color: s.color ?? "#3A6EDB", expected_days: s.expected_days ?? 14, required_fields: s.required_fields ?? [], kind: s.kind ?? "open" }));
    req.ctx.db.insert("stages", { id: id(), workspace_id: req.ctx.ws, pipeline_id: pid, name: "Ganado", position: 98, probability: 100, color: "#2A7B58", expected_days: 365, required_fields: [], kind: "won" });
    req.ctx.db.insert("stages", { id: id(), workspace_id: req.ctx.ws, pipeline_id: pid, name: "Perdido", position: 99, probability: 0, color: "#BF3A4A", expected_days: 365, required_fields: [], kind: "lost" });
    audit(req.ctx, "pipeline", pid, "create", { name: b.name });
    return req.ctx.db.get("SELECT * FROM pipelines WHERE id=?", pid);
  }));
  r.put("/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), is_default: z.boolean().optional(), position: z.number().int().optional() }), req.body);
    if (b.is_default) req.ctx.db.run("UPDATE pipelines SET is_default=0 WHERE workspace_id=?", req.ctx.ws);
    req.ctx.db.update("pipelines", param(req, "id"), b);
    return req.ctx.db.get("SELECT * FROM pipelines WHERE id=?", param(req, "id"));
  }));
  r.delete("/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const n = req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM deals WHERE pipeline_id=? AND deleted_at IS NULL", param(req, "id"))?.n ?? 0;
    if (n) throw badRequest(`El pipeline tiene ${n} negocios. Muévelos antes de borrarlo`);
    req.ctx.db.run("DELETE FROM stages WHERE pipeline_id=?", param(req, "id"));
    req.ctx.db.run("DELETE FROM pipelines WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    return { ok: true };
  }));
  r.post("/:id/stages", h(async (req) => {
    if (!req.ctx.role.permissions.admin) assert(req.ctx, "deal", "update");
    const b = parse(stageSchema, req.body);
    const pos = req.ctx.db.get<{ n: number }>("SELECT COALESCE(MAX(position),-1)+1 n FROM stages WHERE pipeline_id=? AND kind='open'", param(req, "id"))?.n ?? 0;
    const sid = id();
    req.ctx.db.insert("stages", { id: sid, workspace_id: req.ctx.ws, pipeline_id: param(req, "id"), name: b.name, position: pos, probability: b.probability ?? 10, color: b.color ?? "#3A6EDB", expected_days: b.expected_days ?? 14, required_fields: b.required_fields ?? [], kind: "open" });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM stages WHERE id=?", sid), ["required_fields"]);
  }));
  r.put("/:id/stages/:sid", h(async (req) => {
    if (!req.ctx.role.permissions.admin) assert(req.ctx, "deal", "update");
    const b = parse(stageSchema.partial(), req.body);
    const s = req.ctx.db.get<Row>("SELECT * FROM stages WHERE id=? AND workspace_id=?", param(req, "sid"), req.ctx.ws);
    if (!s) throw notFound("Etapa");
    delete (b as Record<string, unknown>).kind;
    req.ctx.db.update("stages", param(req, "sid"), b);
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM stages WHERE id=?", param(req, "sid")), ["required_fields"]);
  }));
  r.put("/:id/stages-order", h(async (req) => {
    if (!req.ctx.role.permissions.admin) assert(req.ctx, "deal", "update");
    const { order } = parse(z.object({ order: z.array(z.string()) }), req.body);
    order.forEach((sid, i) => req.ctx.db.run("UPDATE stages SET position=? WHERE id=? AND pipeline_id=? AND kind='open'", i, sid, param(req, "id")));
    return { ok: true };
  }));
  r.delete("/:id/stages/:sid", h(async (req) => {
    if (!req.ctx.role.permissions.admin) assert(req.ctx, "deal", "update");
    const s = req.ctx.db.get<Row>("SELECT * FROM stages WHERE id=?", param(req, "sid"));
    if (!s) throw notFound("Etapa");
    if (s.kind !== "open") throw badRequest("Las etapas Ganado y Perdido no se pueden borrar");
    const n = req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM deals WHERE stage_id=? AND deleted_at IS NULL", param(req, "sid"))?.n ?? 0;
    if (n) throw badRequest(`Hay ${n} negocios en esta etapa. Muévelos antes de borrarla`);
    req.ctx.db.run("DELETE FROM stages WHERE id=?", param(req, "sid"));
    return { ok: true };
  }));
  return r;
}
