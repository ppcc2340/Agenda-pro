import { enrichOne } from "../services/columns.js";
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { companySchema, listCompanies, getCompany, createCompany, updateCompany, deleteCompany, restoreCompany, companyTree } from "../services/companies.js";
import { listQuery } from "../services/records.js";
import { timeline } from "../services/activities.js";
import { assert } from "../lib/permissions.js";
import { toCsv } from "../lib/util.js";
import { audit } from "../services/audit.js";
import type { Row } from "../db.js";

export function companyRoutes() {
  const r = Router();
  r.get("/", h(async (req) => listCompanies(req.ctx, parse(listQuery, req.query))));
  r.get("/export", h(async (req, res) => {
    assert(req.ctx, "company", "export");
    const q = parse(listQuery, { ...req.query, page: 1, page_size: 500 });
    const all: Row[] = [];
    for (let page = 1; page <= 200; page++) { const r2 = listCompanies(req.ctx, { ...q, page }); all.push(...r2.items); if (r2.items.length < q.page_size) break; }
    audit(req.ctx, "company", null, "export", { count: all.length });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="empresas-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + toCsv(all, ["id", "name", "domain", "sector", "size", "revenue", "tax_id", "city", "country", "phone", "type", "owner_name", "tags", "contacts_count", "open_deals", "created_at"]));
  }));
  r.post("/", h(async (req) => createCompany(req.ctx, parse(companySchema, req.body), { force: req.query.force === "1" || req.body?.force === true })));
  r.get("/:id", h(async (req) => {
    const c = getCompany(req.ctx, param(req, "id"))
    enrichOne(req.ctx, "company", c);
    const db = req.ctx.db;
    return {
      ...c,
      contacts: db.all("SELECT id, first_name, last_name, email, phone, job_title, lifecycle_stage, last_activity_at FROM contacts WHERE company_id=? AND deleted_at IS NULL ORDER BY last_name, first_name", c.id),
      deals: db.all("SELECT d.id, d.name, d.amount, d.currency, d.status, d.probability, d.expected_close_date, s.name stage_name, s.color stage_color, (SELECT name FROM users WHERE id=d.owner_id) owner_name FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=? AND d.deleted_at IS NULL ORDER BY d.status='open' DESC, d.updated_at DESC", c.id),
      tasks: db.all("SELECT t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name FROM tasks t WHERE t.company_id=? AND t.completed_at IS NULL ORDER BY t.due_at", c.id),
      tickets: db.all("SELECT id, number, subject, status, priority, created_at FROM tickets WHERE company_id=? ORDER BY created_at DESC", c.id),
      children: db.all("SELECT id, name, type FROM companies WHERE parent_id=? AND deleted_at IS NULL", c.id),
      stats: db.get("SELECT COALESCE(SUM(CASE WHEN status='won' THEN amount END),0) won_amount, COUNT(CASE WHEN status='won' THEN 1 END) won_count, COALESCE(SUM(CASE WHEN status='open' THEN amount END),0) open_amount FROM deals WHERE company_id=? AND deleted_at IS NULL", c.id),
    };
  }));
  r.get("/:id/timeline", h(async (req) => ({ items: timeline(req.ctx, { company_id: param(req, "id") }, typeof req.query.types === "string" && req.query.types ? req.query.types.split(",") : undefined) })));
  r.get("/:id/history", h(async (req) => ({ items: req.ctx.db.all("SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.object='company' AND a.record_id=? ORDER BY a.created_at DESC LIMIT 200", param(req, "id")).map((x) => ({ ...x, changes: JSON.parse(String(x.changes || "{}")) })) })));
  r.get("/:id/tree", h(async (req) => companyTree(req.ctx, param(req, "id"))));
  r.put("/:id", h(async (req) => updateCompany(req.ctx, param(req, "id"), parse(companySchema.partial(), req.body))));
  r.patch("/:id", h(async (req) => updateCompany(req.ctx, param(req, "id"), parse(companySchema.partial(), req.body))));
  r.delete("/:id", h(async (req) => { deleteCompany(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/:id/restore", h(async (req) => { restoreCompany(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/bulk", h(async (req) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1), action: z.enum(["update", "delete"]), patch: companySchema.partial().optional() }), req.body);
    let n = 0;
    for (const cid of b.ids) { try { if (b.action === "delete") deleteCompany(req.ctx, cid); else if (b.patch) updateCompany(req.ctx, cid, b.patch); n++; } catch (e) { console.warn("[bulk]", (e as Error).message); } }
    return { ok: true, affected: n };
  }));
  return r;
}
