import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { taskSchema, listTasks, getTask, createTask, updateTask, completeTask, reopenTask, deleteTask, myDay } from "../services/tasks.js";

export function taskRoutes() {
  const r = Router();
  r.get("/", h(async (req) => listTasks(req.ctx, { status: typeof req.query.status === "string" ? req.query.status : undefined, assignee_id: typeof req.query.assignee_id === "string" ? req.query.assignee_id : undefined, q: typeof req.query.q === "string" ? req.query.q : undefined, deal_id: typeof req.query.deal_id === "string" ? req.query.deal_id : undefined, contact_id: typeof req.query.contact_id === "string" ? req.query.contact_id : undefined, company_id: typeof req.query.company_id === "string" ? req.query.company_id : undefined, page: Number(req.query.page) || 1, page_size: Number(req.query.page_size) || 100 })));
  r.get("/my-day", h(async (req) => myDay(req.ctx, typeof req.query.user_id === "string" && req.ctx.role.permissions.admin ? req.query.user_id : req.ctx.user.id)));
  r.post("/", h(async (req) => createTask(req.ctx, parse(taskSchema, req.body))));
  r.get("/:id", h(async (req) => getTask(req.ctx, param(req, "id"))));
  r.put("/:id", h(async (req) => updateTask(req.ctx, param(req, "id"), parse(taskSchema.partial(), req.body))));
  r.post("/:id/complete", h(async (req) => { const b = parse(z.object({ outcome: z.string().nullable().optional(), note: z.string().nullable().optional() }), req.body ?? {}); return completeTask(req.ctx, param(req, "id"), b.outcome, b.note); }));
  r.post("/:id/reopen", h(async (req) => reopenTask(req.ctx, param(req, "id"))));
  r.delete("/:id", h(async (req) => { deleteTask(req.ctx, param(req, "id")); return { ok: true }; }));
  return r;
}
