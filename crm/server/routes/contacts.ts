import { enrichOne } from "../services/columns.js";
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { contactSchema, listContacts, getContact, createContact, updateContact, deleteContact, restoreContact, mergeContacts, undoMerge, duplicateGroups, exportContactData, anonymizeContact, findDuplicateCandidates } from "../services/contacts.js";
import { listQuery } from "../services/records.js";
import { timeline } from "../services/activities.js";
import { convertSchema, convertContact } from "../services/deals.js";
import { assert } from "../lib/permissions.js";
import { toCsv } from "../lib/util.js";
import { audit } from "../services/audit.js";
import type { Row } from "../db.js";
import { visibleColumns, redactAll, assertWritable } from "../services/fieldSecurity.js";

export function contactRoutes() {
  const r = Router();
  r.get("/", h(async (req) => listContacts(req.ctx, parse(listQuery, req.query))));
  r.get("/export", h(async (req, res) => {
    assert(req.ctx, "contact", "export");
    const q = parse(listQuery, { ...req.query, page: 1, page_size: 500 });
    const all: Row[] = [];
    for (let page = 1; page <= 200; page++) {
      const r2 = listContacts(req.ctx, { ...q, page });
      all.push(...r2.items);
      if (r2.items.length < q.page_size) break;
    }
    audit(req.ctx, "contact", null, "export", { count: all.length });
    const cols = ["id", "first_name", "last_name", "email", "phone", "job_title", "company_name", "lifecycle_stage", "lead_status", "source", "owner_name", "score", "city", "country", "tags", "consent_marketing", "created_at", "last_activity_at"];
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + toCsv(all, visibleColumns(req.ctx, "contact", cols)));
  }));
  r.get("/duplicates", h(async (req) => ({ groups: duplicateGroups(req.ctx) })));
  r.post("/check-duplicates", h(async (req) => ({ duplicates: findDuplicateCandidates(req.ctx, req.body ?? {}, typeof req.body?.exclude_id === "string" ? req.body.exclude_id : undefined) })));
  r.post("/merge", h(async (req) => {
    const b = parse(z.object({ survivor_id: z.string(), merged_id: z.string(), choices: z.record(z.string(), z.enum(["a", "b"])).optional() }), req.body);
    return mergeContacts(req.ctx, b.survivor_id, b.merged_id, b.choices);
  }));
  r.post("/merges/:id/undo", h(async (req) => { undoMerge(req.ctx, param(req, "id")); return { ok: true }; }));
  r.get("/merges", h(async (req) => ({ items: req.ctx.db.all("SELECT m.id, m.survivor_id, m.merged_id, m.created_at, u.name user_name, (SELECT first_name||' '||last_name FROM contacts WHERE id=m.survivor_id) survivor_name FROM merges m LEFT JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.object='contact' AND m.created_at > datetime('now','-30 days') ORDER BY m.created_at DESC", req.ctx.ws) })));
  r.post("/", h(async (req) => createContact(req.ctx, parse(contactSchema, req.body), { force: req.query.force === "1" || req.body?.force === true })));
  r.get("/:id", h(async (req) => {
    const c = getContact(req.ctx, param(req, "id"))
    enrichOne(req.ctx, "contact", c);
    const db = req.ctx.db;
    return {
      ...c,
      deals: db.all("SELECT d.id, d.name, d.amount, d.currency, d.status, d.probability, d.expected_close_date, dc.role, s.name stage_name, s.color stage_color FROM deals d JOIN deal_contacts dc ON dc.deal_id=d.id JOIN stages s ON s.id=d.stage_id WHERE dc.contact_id=? AND d.deleted_at IS NULL ORDER BY d.status='open' DESC, d.updated_at DESC", c.id),
      tasks: db.all("SELECT t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name FROM tasks t WHERE t.contact_id=? AND t.completed_at IS NULL ORDER BY t.due_at", c.id),
      tickets: db.all("SELECT id, number, subject, status, priority, created_at FROM tickets WHERE contact_id=? ORDER BY created_at DESC", c.id),
      lists: db.all("SELECT l.id, l.name FROM lists l JOIN list_members m ON m.list_id=l.id WHERE m.record_id=?", c.id),
      submissions: db.all("SELECT s.id, s.created_at, f.name form_name, s.data FROM form_submissions s JOIN forms f ON f.id=s.form_id WHERE s.contact_id=? ORDER BY s.created_at DESC", c.id),
    };
  }));
  r.get("/:id/timeline", h(async (req) => ({ items: timeline(req.ctx, { contact_id: param(req, "id") }, typeof req.query.types === "string" && req.query.types ? req.query.types.split(",") : undefined) })));
  r.get("/:id/history", h(async (req) => ({ items: req.ctx.db.all("SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.object='contact' AND a.record_id=? ORDER BY a.created_at DESC LIMIT 200", param(req, "id")).map((x) => ({ ...x, changes: JSON.parse(String(x.changes || "{}")) })) })));
  r.put("/:id", h(async (req) => updateContact(req.ctx, param(req, "id"), parse(contactSchema.partial(), req.body))));
  r.patch("/:id", h(async (req) => updateContact(req.ctx, param(req, "id"), parse(contactSchema.partial(), req.body))));
  r.delete("/:id", h(async (req) => { deleteContact(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/:id/restore", h(async (req) => { restoreContact(req.ctx, param(req, "id")); return { ok: true }; }));
  r.post("/:id/convert", h(async (req) => convertContact(req.ctx, param(req, "id"), parse(convertSchema, req.body))));
  r.get("/:id/gdpr-export", h(async (req, res) => {
    const data = exportContactData(req.ctx, param(req, "id"));
    res.setHeader("content-disposition", `attachment; filename="datos-${param(req, "id")}.json"`);
    return data;
  }));
  r.post("/:id/anonymize", h(async (req) => anonymizeContact(req.ctx, param(req, "id"))));
  r.post("/bulk", h(async (req) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1), action: z.enum(["update", "delete", "add_tag", "remove_tag", "add_to_list"]), patch: contactSchema.partial().optional(), tag: z.string().optional(), list_id: z.string().optional() }), req.body);
    let n = 0;
    for (const cid of b.ids) {
      try {
        if (b.action === "delete") deleteContact(req.ctx, cid);
        else if (b.action === "update" && b.patch) updateContact(req.ctx, cid, b.patch);
        else if (b.action === "add_tag" && b.tag) { const c = getContact(req.ctx, cid); const tags = c.tags as string[]; if (!tags.includes(b.tag)) updateContact(req.ctx, cid, { tags: [...tags, b.tag] }); }
        else if (b.action === "remove_tag" && b.tag) { const c = getContact(req.ctx, cid); updateContact(req.ctx, cid, { tags: (c.tags as string[]).filter((t) => t !== b.tag) }); }
        else if (b.action === "add_to_list" && b.list_id) req.ctx.db.run("INSERT OR IGNORE INTO list_members (list_id, record_id, added_at) VALUES (?,?,datetime('now'))", b.list_id, cid);
        n++;
      } catch (e) { console.warn("[bulk]", (e as Error).message); }
    }
    return { ok: true, affected: n };
  }));
  return r;
}
