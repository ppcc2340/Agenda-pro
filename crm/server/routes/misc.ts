import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { id, now } from "../lib/util.js";
import { badRequest, notFound } from "../lib/errors.js";
import { assert } from "../lib/permissions.js";
import { parseJson, type Row } from "../db.js";
import { buildWhere, OBJECT_FIELDS, OPS } from "../lib/filters.js";
import { listRecords, listQuery, parseFilters, customFieldDefs } from "../services/records.js";
import { ownerScope } from "../lib/permissions.js";
import { createContact, updateContact, getContact } from "../services/contacts.js";
import { createCompany, findCompanyByDomain, findCompanyByName } from "../services/companies.js";
import { createDeal } from "../services/deals.js";
import { normalizeEmail, normalizeDomain, domainFromEmail, FREE_EMAIL_DOMAINS } from "../lib/util.js";
import { audit } from "../services/audit.js";
import { HttpError } from "../lib/errors.js";

export function miscRoutes() {
  const r = Router();

  // ---------- global search (13.9) ----------
  r.get("/search", h(async (req) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return { contacts: [], companies: [], deals: [], tickets: [], quotes: [] };
    const like = `%${q}%`;
    const db = req.ctx.db, ws = req.ctx.ws;
    const cs = ownerScope(req.ctx, "owner_id"), ds = ownerScope(req.ctx, "owner_id");
    return {
      contacts: db.all(`SELECT id, first_name, last_name, email, phone, (SELECT name FROM companies WHERE id=contacts.company_id) company_name FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND ${cs.sql} AND (first_name||' '||last_name LIKE ? OR email LIKE ? OR phone LIKE ?) LIMIT 8`, ws, ...cs.params, like, like, like),
      companies: db.all(`SELECT id, name, domain, city FROM companies WHERE workspace_id=? AND deleted_at IS NULL AND ${cs.sql} AND (name LIKE ? OR domain LIKE ? OR tax_id LIKE ?) LIMIT 6`, ws, ...cs.params, like, like, like),
      deals: db.all(`SELECT d.id, d.name, d.amount, d.currency, d.status, (SELECT name FROM companies WHERE id=d.company_id) company_name, (SELECT name FROM stages WHERE id=d.stage_id) stage_name FROM deals d WHERE workspace_id=? AND deleted_at IS NULL AND ${ds.sql} AND name LIKE ? LIMIT 6`, ws, ...ds.params, like),
      tickets: db.all(`SELECT id, number, subject, status FROM tickets WHERE workspace_id=? AND (subject LIKE ? OR CAST(number AS TEXT)=?) LIMIT 5`, ws, like, q.replace("#", "")),
      contracts: db.all(`SELECT id, number, title, status FROM contracts WHERE workspace_id=? AND deleted_at IS NULL AND ${ds.sql} AND (title LIKE ? OR number LIKE ?) LIMIT 6`, ws, ...ds.params, like, like),
      quotes: db.all(`SELECT id, number, status, total, deal_id FROM quotes WHERE workspace_id=? AND number LIKE ? LIMIT 5`, ws, like),
    };
  }));

  // ---------- notifications (13.8) ----------
  r.get("/notifications", h(async (req) => ({ items: req.ctx.db.all("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50", req.ctx.user.id), unread: req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", req.ctx.user.id)?.n ?? 0 })));
  r.post("/notifications/read", h(async (req) => { const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null; if (ids) ids.forEach((i) => req.ctx.db.run("UPDATE notifications SET read_at=? WHERE id=? AND user_id=?", now(), i, req.ctx.user.id)); else req.ctx.db.run("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", now(), req.ctx.user.id); return { ok: true }; }));

  // ---------- saved views (2.2) ----------
  r.get("/views", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM views WHERE workspace_id=? AND (user_id=? OR shared=1) AND (?='' OR object=?) ORDER BY name", req.ctx.ws, req.ctx.user.id, String(req.query.object ?? ""), String(req.query.object ?? "")).map((v) => parseJson(v, ["filters", "columns", "sort"])) })));
  const viewSchema = z.object({ object: z.string(), name: z.string().trim().min(1).max(100), filters: z.any().optional(), columns: z.array(z.string()).optional(), sort: z.object({ field: z.string().optional(), dir: z.string().optional() }).optional(), shared: z.boolean().optional() });
  r.post("/views", h(async (req) => { const b = parse(viewSchema, req.body); const vid = id(); req.ctx.db.insert("views", { id: vid, workspace_id: req.ctx.ws, object: b.object, name: b.name, filters: b.filters ?? {}, columns: b.columns ?? [], sort: b.sort ?? {}, shared: b.shared ? 1 : 0, user_id: req.ctx.user.id, created_at: now() }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM views WHERE id=?", vid), ["filters", "columns", "sort"]); }));
  r.put("/views/:id", h(async (req) => { const b = parse(viewSchema.partial(), req.body); const v = req.ctx.db.get<Row>("SELECT * FROM views WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); if (!v) throw notFound("Vista"); if (v.user_id !== req.ctx.user.id && !req.ctx.role.permissions.admin) throw new HttpError(403, "Solo el creador puede editar esta vista"); req.ctx.db.update("views", v.id as string, { ...b, shared: b.shared === undefined ? undefined : b.shared ? 1 : 0 }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM views WHERE id=?", v.id), ["filters", "columns", "sort"]); }));
  r.delete("/views/:id", h(async (req) => { req.ctx.db.run("DELETE FROM views WHERE id=? AND workspace_id=? AND (user_id=? OR ?=1)", param(req, "id"), req.ctx.ws, req.ctx.user.id, req.ctx.role.permissions.admin ? 1 : 0); return { ok: true }; }));
  // ----- board configuration (columns, labels, groups) -----
  const boardObj = z.enum(["contact", "company", "deal", "ticket", "contract"]);
  r.get("/boards/:object", h(async (req) => { const o = boardObj.parse(param(req, "object")); const row = req.ctx.db.get<Row>("SELECT * FROM board_configs WHERE workspace_id=? AND object=?", req.ctx.ws, o); return { object: o, config: row ? JSON.parse(String(row.config)) : {}, updated_at: row?.updated_at ?? null }; }));
  r.put("/boards/:object", h(async (req) => {
    const o = boardObj.parse(param(req, "object"));
    assert(req.ctx, o, "update");
    const cfg = parse(z.object({ order: z.array(z.string()).optional(), columns: z.array(z.object({ key: z.string(), label: z.string().optional(), width: z.number().optional(), hidden: z.boolean().optional() })).optional(), labels: z.record(z.string(), z.record(z.string(), z.object({ label: z.string().optional(), color: z.string().optional() }))).optional(), group_by: z.string().nullable().optional(), groups: z.record(z.string(), z.record(z.string(), z.object({ label: z.string().optional(), color: z.string().optional(), hidden: z.boolean().optional() }))).optional(), group_order: z.record(z.string(), z.array(z.string())).optional() }), req.body);
    req.ctx.db.run("INSERT INTO board_configs (workspace_id, object, config, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, object) DO UPDATE SET config=excluded.config, updated_by=excluded.updated_by, updated_at=excluded.updated_at", req.ctx.ws, o, JSON.stringify(cfg), req.ctx.user.id, now());
    return { object: o, config: cfg };
  }));
  r.get("/filter-meta", h(async (req) => ({ fields: OBJECT_FIELDS, ops: OPS, custom: { contact: customFieldDefs(req.ctx, "contact"), company: customFieldDefs(req.ctx, "company"), deal: customFieldDefs(req.ctx, "deal"), ticket: customFieldDefs(req.ctx, "ticket"), contract: customFieldDefs(req.ctx, "contract") } })));

  // ---------- lists / segments (2.2, 2.3) ----------
  r.get("/lists", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT l.*, (SELECT COUNT(*) FROM list_members m WHERE m.list_id=l.id) members FROM lists l WHERE workspace_id=? ORDER BY name", req.ctx.ws).map((l) => parseJson(l, ["filters"])) })));
  r.post("/lists", h(async (req) => { const b = parse(z.object({ object: z.enum(["contact", "company", "deal"]).default("contact"), name: z.string().trim().min(1), kind: z.enum(["static", "dynamic"]).default("static"), filters: z.any().optional() }), req.body); if (b.kind === "dynamic") buildWhere(b.object, parseFilters(b.filters)); const lid = id(); req.ctx.db.insert("lists", { id: lid, workspace_id: req.ctx.ws, object: b.object, name: b.name, kind: b.kind, filters: b.filters ?? {}, created_by: req.ctx.user.id, created_at: now() }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM lists WHERE id=?", lid), ["filters"]); }));
  r.put("/lists/:id", h(async (req) => { const b = parse(z.object({ name: z.string().trim().min(1).optional(), filters: z.any().optional() }), req.body); req.ctx.db.update("lists", param(req, "id"), b); return parseJson(req.ctx.db.get<Row>("SELECT * FROM lists WHERE id=?", param(req, "id")), ["filters"]); }));
  r.delete("/lists/:id", h(async (req) => { req.ctx.db.run("DELETE FROM list_members WHERE list_id=?", param(req, "id")); req.ctx.db.run("DELETE FROM lists WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  r.get("/lists/:id/members", h(async (req) => {
    const l = parseJson(req.ctx.db.get<Row>("SELECT * FROM lists WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws), ["filters"]);
    if (!l) throw notFound("Lista");
    const q = parse(listQuery, req.query);
    if (l.kind === "dynamic") return { list: l, ...listRecords(req.ctx, l.object as string, { ...q, filters: l.filters }, { select: l.object === "contact" ? "(SELECT name FROM companies WHERE id=t.company_id) company_name" : undefined }) };
    return { list: l, ...listRecords(req.ctx, l.object as string, q, { where: "t.id IN (SELECT record_id FROM list_members WHERE list_id=?)", params: [l.id], select: l.object === "contact" ? "(SELECT name FROM companies WHERE id=t.company_id) company_name" : undefined }) };
  }));
  r.post("/lists/:id/members", h(async (req) => { const { ids } = parse(z.object({ ids: z.array(z.string()).min(1) }), req.body); for (const rid of ids) req.ctx.db.run("INSERT OR IGNORE INTO list_members (list_id, record_id, added_at) VALUES (?,?,?)", param(req, "id"), rid, now()); return { ok: true }; }));
  r.delete("/lists/:id/members/:rid", h(async (req) => { req.ctx.db.run("DELETE FROM list_members WHERE list_id=? AND record_id=?", param(req, "id"), param(req, "rid")); return { ok: true }; }));

  // ---------- email templates (7.1) ----------
  r.get("/email-templates", h(async (req) => ({ items: req.ctx.db.all("SELECT t.*, u.name created_by_name FROM email_templates t LEFT JOIN users u ON u.id=t.created_by WHERE t.workspace_id=? ORDER BY folder, name", req.ctx.ws) })));
  const tplSchema = z.object({ name: z.string().trim().min(1), folder: z.string().nullable().optional(), subject: z.string().min(1), body: z.string().min(1) });
  r.post("/email-templates", h(async (req) => { const b = parse(tplSchema, req.body); const tid = id(); req.ctx.db.insert("email_templates", { id: tid, workspace_id: req.ctx.ws, ...b, folder: b.folder ?? null, created_by: req.ctx.user.id, created_at: now(), updated_at: now() }); return req.ctx.db.get("SELECT * FROM email_templates WHERE id=?", tid); }));
  r.put("/email-templates/:id", h(async (req) => { const b = parse(tplSchema.partial(), req.body); req.ctx.db.update("email_templates", param(req, "id"), { ...b, updated_at: now() }); return req.ctx.db.get("SELECT * FROM email_templates WHERE id=?", param(req, "id")); }));
  r.delete("/email-templates/:id", h(async (req) => { req.ctx.db.run("DELETE FROM email_templates WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));

  // ---------- import (13.4) ----------
  r.post("/import", h(async (req) => {
    const b = parse(z.object({ object: z.enum(["contact", "company", "deal"]), file_name: z.string().optional(), mapping: z.record(z.string()), rows: z.array(z.record(z.any())).max(10000), dedupe: z.enum(["skip", "update", "create"]).default("skip"), owner_id: z.string().optional(), source: z.string().optional(), tags: z.array(z.string()).optional(), dry_run: z.boolean().optional() }), req.body);
    assert(req.ctx, b.object, "create");
    const ctx = req.ctx;
    const createdIds: string[] = [];
    const errors: { row: number; message: string }[] = [];
    let created = 0, updated = 0, skipped = 0;
    const map = (row: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const [col, field] of Object.entries(b.mapping)) { if (!field) continue; const v = row[col]; if (v === undefined || v === null || String(v).trim() === "") continue; if (field.startsWith("custom.")) { (o.custom ??= {} as Record<string, unknown>); (o.custom as Record<string, unknown>)[field.slice(7)] = v; } else o[field] = typeof v === "string" ? v.trim() : v; } return o; };
    const companyCache = new Map<string, string>();
    const resolveCompanyId = (name: string | undefined, email: string | null): string | null => {
      const domain = domainFromEmail(email);
      const key = (name ?? domain ?? "").toLowerCase();
      if (!key) return null;
      if (companyCache.has(key)) return companyCache.get(key)!;
      let c = name ? findCompanyByName(ctx, name) : undefined;
      if (!c && domain && !FREE_EMAIL_DOMAINS.has(domain)) c = findCompanyByDomain(ctx, domain);
      if (!c && (name || (domain && !FREE_EMAIL_DOMAINS.has(domain)))) {
        if (b.dry_run) return "dry";
        c = createCompany(ctx, { name: name ?? (domain!.split(".")[0] ?? domain!), domain: domain && !FREE_EMAIL_DOMAINS.has(domain) ? domain : null, owner_id: b.owner_id ?? ctx.user.id }, { force: true, skipEvents: true });
        createdIds.push(`company:${c.id}`);
      }
      const cid = (c?.id as string | undefined) ?? null;
      if (cid) companyCache.set(key, cid);
      return cid;
    };
    const run = () => {
      b.rows.forEach((raw, i) => {
        try {
          const o = map(raw);
          if (b.object === "contact") {
            const email = normalizeEmail(o.email);
            if (!o.first_name && o.full_name) { const parts = String(o.full_name).split(/\s+/); o.first_name = parts.shift(); o.last_name = parts.join(" "); }
            if (!o.first_name && email) o.first_name = email.split("@")[0];
            if (!o.first_name) throw new Error("Falta el nombre");
            const existing = email ? ctx.db.get<Row>("SELECT id FROM contacts WHERE workspace_id=? AND email=? AND deleted_at IS NULL", ctx.ws, email) : undefined;
            const companyId = resolveCompanyId(o.company_name as string | undefined, email);
            const payload = { ...o, email, company_id: companyId === "dry" ? null : companyId, owner_id: (o.owner_id as string | undefined) ?? b.owner_id ?? ctx.user.id, source: (o.source as string | undefined) ?? b.source ?? "import", tags: b.tags } as Record<string, unknown>;
            delete payload.company_name; delete payload.full_name;
            if (existing) {
              if (b.dedupe === "skip") { skipped++; return; }
              if (b.dedupe === "update") { if (!b.dry_run) updateContact(ctx, existing.id as string, payload as never); updated++; return; }
            }
            if (!b.dry_run) { const c = createContact(ctx, payload as never, { force: true, source: "import" }); createdIds.push(`contact:${c.id}`); }
            created++;
          } else if (b.object === "company") {
            const domain = normalizeDomain(o.domain) ?? normalizeDomain(o.website);
            if (!o.name) throw new Error("Falta el nombre");
            const existing = (domain ? findCompanyByDomain(ctx, domain) : undefined) ?? findCompanyByName(ctx, String(o.name));
            if (existing) { if (b.dedupe === "skip") { skipped++; return; } if (b.dedupe === "update") { if (!b.dry_run) ctx.db.update("companies", existing.id as string, { ...o, domain, updated_at: now() }); updated++; return; } }
            if (!b.dry_run) { const c = createCompany(ctx, { ...o, domain, owner_id: b.owner_id ?? ctx.user.id, tags: b.tags } as never, { force: true }); createdIds.push(`company:${c.id}`); }
            created++;
          } else {
            if (!o.name) throw new Error("Falta el nombre");
            const companyId = o.company_name ? resolveCompanyId(String(o.company_name), null) : null;
            let stageId: string | undefined;
            if (o.stage_name) stageId = ctx.db.get<{ id: string }>("SELECT s.id FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.workspace_id=? AND lower(s.name)=lower(?) ORDER BY p.is_default DESC LIMIT 1", ctx.ws, String(o.stage_name))?.id;
            if (!b.dry_run) { const d = createDeal(ctx, { name: String(o.name), amount: Number(o.amount) || 0, company_id: companyId === "dry" ? null : companyId, stage_id: stageId, expected_close_date: (o.expected_close_date as string | undefined) ?? null, owner_id: b.owner_id ?? ctx.user.id, tags: b.tags, custom: o.custom as Record<string, unknown> | undefined }); createdIds.push(`deal:${d.id}`); }
            created++;
          }
        } catch (e) { errors.push({ row: i + 1, message: (e as Error).message }); }
      });
    };
    if (b.dry_run) { run(); return { dry_run: true, total: b.rows.length, created, updated, skipped, errors }; }
    const importId = id();
    ctx.db.transaction(run);
    ctx.db.insert("imports", { id: importId, workspace_id: ctx.ws, object: b.object, file_name: b.file_name ?? null, total: b.rows.length, created, updated, skipped, created_ids: createdIds, errors, user_id: ctx.user.id, created_at: now() });
    audit(ctx, "import", importId, "create", { object: b.object, created, updated, skipped });
    return { id: importId, total: b.rows.length, created, updated, skipped, errors };
  }));
  r.get("/imports", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT i.*, u.name user_name FROM imports i LEFT JOIN users u ON u.id=i.user_id WHERE i.workspace_id=? ORDER BY i.created_at DESC LIMIT 50", req.ctx.ws).map((x) => parseJson(x, ["errors", "created_ids"])) })));
  r.post("/imports/:id/revert", h(async (req) => {
    const imp = parseJson(req.ctx.db.get<Row>("SELECT * FROM imports WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws), ["created_ids"]);
    if (!imp) throw notFound("Importación");
    if (imp.reverted_at) throw badRequest("Ya revertida");
    for (const ref of imp.created_ids as string[]) { const [obj, rid] = ref.split(":"); const table = { contact: "contacts", company: "companies", deal: "deals" }[obj ?? ""]; if (table && rid) req.ctx.db.run(`UPDATE ${table} SET deleted_at=? WHERE id=?`, now(), rid); }
    req.ctx.db.update("imports", imp.id as string, { reverted_at: now() });
    audit(req.ctx, "import", imp.id as string, "delete", { reverted: (imp.created_ids as string[]).length });
    return { ok: true, reverted: (imp.created_ids as string[]).length };
  }));

  r.get("/contacts-lookup", h(async (req) => { const c = getContact(req.ctx, String(req.query.id)); return c; }));
  return r;
}
