import { convertField } from "../services/convert.js";
import { isBoardObject, isCustomObjectKey } from "../lib/objectKeys.js";
import { listDefs, getDef } from "../services/customObjects.js";
import { passwordSchema } from "../lib/security.js";
import { auditHash } from "../db.js";
import { CUSTOM_TYPES } from "../services/columns.js";
import { validateFieldSettings, fieldDependents } from "../services/columnAdmin.js";
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { assertAdmin, assert, PRESET_ROLES, OBJECTS, ACTIONS } from "../lib/permissions.js";
import { id, now, hashPassword, token, sha256 } from "../lib/util.js";
import { badRequest, notFound, conflict } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { publicUser } from "./auth.js";
import { DEFAULT_SETTINGS, type Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { emailMode, sentLog } from "../services/email.js";
import { attemptDelivery } from "../services/webhooks.js";

const permSchema = z.record(z.string(), z.union([z.array(z.string()), z.boolean()]));

export function adminRoutes() {
  const r = Router();

  // ---------- users ----------
  r.get("/users", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM users WHERE workspace_id=? ORDER BY active DESC, name", req.ctx.ws).map((u) => publicUser(req.ctx.db, u)) })));
  r.post("/users", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1), email: z.string().email(), password: passwordSchema(String(req.body?.email ?? "")), role_id: z.string(), team_id: z.string().nullable().optional(), quota: z.number().nullable().optional() }), req.body);
    if (req.ctx.db.get("SELECT id FROM users WHERE email=?", b.email.toLowerCase())) throw badRequest("Ya existe un usuario con ese email");
    const uid = id();
    req.ctx.db.insert("users", { id: uid, workspace_id: req.ctx.ws, name: b.name, email: b.email.toLowerCase(), password_hash: hashPassword(b.password), role_id: b.role_id, team_id: b.team_id ?? null, quota: b.quota ?? null, created_at: now() });
    audit(req.ctx, "user", uid, "create", { email: b.email });
    return publicUser(req.ctx.db, req.ctx.db.get<Row>("SELECT * FROM users WHERE id=?", uid)!);
  }));
  r.put("/users/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1).optional(), role_id: z.string().optional(), team_id: z.string().nullable().optional(), active: z.boolean().optional(), quota: z.number().nullable().optional(), password: passwordSchema().optional() }), req.body);
    const u = req.ctx.db.get<Row>("SELECT * FROM users WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!u) throw notFound("Usuario");
    if (b.active === false && u.id === req.ctx.user.id) throw badRequest("No puedes desactivarte a ti mismo");
    const patch: Record<string, unknown> = { name: b.name, role_id: b.role_id, team_id: b.team_id, quota: b.quota, active: b.active === undefined ? undefined : b.active ? 1 : 0 };
    if (b.password) { patch.password_hash = hashPassword(b.password); patch.password_changed_at = now(); }
    req.ctx.db.update("users", u.id as string, patch);
    if (b.active === false) req.ctx.db.run("DELETE FROM sessions WHERE user_id=?", u.id);
    audit(req.ctx, "user", u.id as string, b.role_id && b.role_id !== u.role_id ? "permission" : "update", { role_id: b.role_id ? [u.role_id, b.role_id] : undefined, active: b.active, password_reset: !!b.password });
    return publicUser(req.ctx.db, req.ctx.db.get<Row>("SELECT * FROM users WHERE id=?", u.id)!);
  }));

  // ---------- roles ----------
  r.get("/roles", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) users_count FROM roles r WHERE workspace_id=? ORDER BY is_system DESC, name", req.ctx.ws).map((x) => parseJson(x, ["permissions"])), objects: [...OBJECTS, ...listDefs(req.ctx).map((d) => d.key)], object_labels: Object.fromEntries(listDefs(req.ctx).map((d) => [d.key, d.plural])), actions: ACTIONS, presets: PRESET_ROLES })));
  r.post("/roles", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1), key: z.string().regex(/^[a-z0-9_]+$/), permissions: permSchema, visibility: z.enum(["own", "team", "all"]) }), req.body);
    const rid = id();
    req.ctx.db.insert("roles", { id: rid, workspace_id: req.ctx.ws, name: b.name, key: b.key, permissions: b.permissions, visibility: b.visibility, is_system: 0 });
    audit(req.ctx, "role", rid, "permission", { created: b.key });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM roles WHERE id=?", rid), ["permissions"]);
  }));
  r.put("/roles/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1).optional(), permissions: permSchema.optional(), visibility: z.enum(["own", "team", "all"]).optional() }), req.body);
    const role = req.ctx.db.get<Row>("SELECT * FROM roles WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!role) throw notFound("Rol");
    if (role.key === "admin" && b.permissions && !b.permissions.admin) throw badRequest("El rol administrador conserva siempre permisos de administración");
    req.ctx.db.update("roles", role.id as string, b);
    audit(req.ctx, "role", role.id as string, "permission", { permissions: b.permissions, visibility: b.visibility });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM roles WHERE id=?", role.id), ["permissions"]);
  }));
  r.delete("/roles/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const role = req.ctx.db.get<Row>("SELECT * FROM roles WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!role) throw notFound("Rol");
    if (role.is_system) throw badRequest("Los roles del sistema no se borran");
    if (req.ctx.db.get("SELECT id FROM users WHERE role_id=?", role.id)) throw badRequest("Hay usuarios con este rol");
    req.ctx.db.run("DELETE FROM roles WHERE id=?", role.id);
    return { ok: true };
  }));

  // ---------- teams ----------
  r.get("/teams", h(async (req) => ({ items: req.ctx.db.all("SELECT t.*, (SELECT name FROM users WHERE id=t.manager_id) manager_name, (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id AND u.active=1) members FROM teams t WHERE t.workspace_id=? ORDER BY t.name", req.ctx.ws) })));
  r.post("/teams", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1), manager_id: z.string().nullable().optional() }), req.body);
    const tid = id();
    req.ctx.db.insert("teams", { id: tid, workspace_id: req.ctx.ws, name: b.name, manager_id: b.manager_id ?? null, created_at: now() });
    return req.ctx.db.get("SELECT * FROM teams WHERE id=?", tid);
  }));
  r.put("/teams/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1).optional(), manager_id: z.string().nullable().optional() }), req.body);
    req.ctx.db.update("teams", param(req, "id"), b);
    return req.ctx.db.get("SELECT * FROM teams WHERE id=?", param(req, "id"));
  }));
  r.delete("/teams/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("UPDATE users SET team_id=NULL WHERE team_id=?", param(req, "id")); req.ctx.db.run("DELETE FROM teams WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));

  // ---------- custom fields ----------
  r.get("/custom-fields", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM custom_fields WHERE workspace_id=? ORDER BY object, position", req.ctx.ws).map((f) => parseJson(f, ["options", "show_if", "settings"])) })));
  const cfSchema = z.object({ object: z.string().refine(isBoardObject, "Objeto no válido"), key: z.string().regex(/^[a-z][a-z0-9_]*$/, "Clave en minúsculas, sin espacios"), label: z.string().trim().min(1), type: z.enum(CUSTOM_TYPES), options: z.array(z.string()).optional(), settings: z.record(z.string(), z.unknown()).optional(), required: z.boolean().optional(), default_value: z.string().nullable().optional(), position: z.number().int().optional(), section: z.string().nullable().optional(), show_if: z.object({ field: z.string(), value: z.string() }).nullable().optional() });
  const canEditFields = (ctx: Ctx, object: string) => { if (!ctx.role.permissions.admin) assert(ctx, object, "update"); };
  r.post("/custom-fields", h(async (req) => {
    const b = parse(cfSchema, req.body);
    canEditFields(req.ctx, b.object);
    if (isCustomObjectKey(b.object)) getDef(req.ctx, b.object);
    if (req.ctx.db.get("SELECT id FROM custom_fields WHERE workspace_id=? AND object=? AND key=?", req.ctx.ws, b.object, b.key)) throw badRequest("Ya existe un campo con esa clave");
    const fid = id();
    const pos = req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_fields WHERE workspace_id=? AND object=?", req.ctx.ws, b.object)?.n ?? 0;
    req.ctx.db.insert("custom_fields", { id: fid, workspace_id: req.ctx.ws, object: b.object, key: b.key, label: b.label, type: b.type, options: b.options ?? [], settings: validateFieldSettings(req.ctx, b.object, b.type, b.settings ?? {}, b.key), required: b.required ? 1 : 0, default_value: b.default_value ?? null, position: b.position ?? pos, section: b.section ?? null, show_if: b.show_if ?? null });
    audit(req.ctx, "custom_field", fid, "create", { object: b.object, key: b.key });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM custom_fields WHERE id=?", fid), ["options", "show_if", "settings"]);
  }));
  r.put("/custom-fields/:id", h(async (req) => {
    const cur = req.ctx.db.get<Row>("SELECT * FROM custom_fields WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!cur) throw notFound("Campo");
    canEditFields(req.ctx, String(cur.object));
    const b = parse(cfSchema.partial().omit({ object: true, key: true }), req.body);
    const type = b.type ?? String(cur.type);
    let settingsIn = b.settings;
    // cambio de tipo: convierte los valores existentes (y genera etiquetas/opciones a partir de ellos)
    if (b.type && b.type !== cur.type) {
      const rep = convertField(req.ctx, String(cur.object), String(cur.key), b.type, (b.settings ?? {}) as Record<string, unknown>, true);
      if (b.type === "status" && !(b.settings as Record<string, unknown> | undefined)?.labels && !(b.settings as Record<string, unknown> | undefined)?.label_set_id) settingsIn = { ...(b.settings ?? {}), labels: rep.labels ?? [] };
      if ((b.type === "select" || b.type === "multiselect") && !b.options) b.options = rep.options ?? [];
      if (settingsIn === undefined) settingsIn = {};
    }
    const settings = settingsIn !== undefined ? validateFieldSettings(req.ctx, String(cur.object), type, settingsIn, String(cur.key), String(cur.id)) : undefined;
    req.ctx.db.update("custom_fields", param(req, "id"), { ...b, settings, required: b.required === undefined ? undefined : b.required ? 1 : 0 });
    audit(req.ctx, "custom_field", param(req, "id"), "update", { label: b.label, type: b.type });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM custom_fields WHERE id=?", param(req, "id")), ["options", "show_if", "settings"]);
  }));
  r.delete("/custom-fields/:id", h(async (req) => { const cur = req.ctx.db.get<Row>("SELECT * FROM custom_fields WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); if (!cur) throw notFound("Campo"); canEditFields(req.ctx, String(cur.object)); const deps = fieldDependents(req.ctx, String(cur.object), String(cur.key), String(cur.label)); if (deps.length && req.query.force !== "1") throw conflict(`La columna «${cur.label}» se usa en ${deps.length} sitio(s); bórrala igualmente solo si ya los has revisado`, { dependents: deps }); audit(req.ctx, "custom_field", String(cur.id), "delete", { key: cur.key }); req.ctx.db.run("DELETE FROM custom_fields WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));

  // ---------- settings ----------
  r.get("/settings", h(async (req) => ({ settings: req.ctx.settings, email_mode: emailMode(), public_url: process.env.PUBLIC_URL ?? "http://localhost:3000" })));
  r.put("/settings", h(async (req) => {
    assertAdmin(req.ctx);
    const schema = z.object({
      company_name: z.string().trim().min(1).optional(), currency: z.string().length(3).optional(), timezone: z.string().optional(), date_format: z.string().optional(), default_country_code: z.string().regex(/^\+\d{1,4}$/).optional(),
      internal_domains: z.array(z.string()).optional(), fiscal_year_start: z.number().int().min(1).max(12).optional(), stale_deal_days: z.number().int().min(1).optional(), inactive_deal_days: z.number().int().min(1).optional(), lead_sla_hours: z.number().min(1).optional(),
      mql_threshold: z.number().optional(), sql_threshold: z.number().optional(), retention_months: z.number().int().min(1).optional(), retention_enabled: z.boolean().optional(), quote_prefix: z.string().max(10).optional(), quote_accept_stage_id: z.string().nullable().optional(), ticket_sla_hours: z.record(z.string(), z.number()).optional(), logo_url: z.string().optional(), brand_color: z.string().optional(),
    });
    const b = { ...parse(schema, req.body), ...parse(z.object({ automation_budget: z.number().int().min(0).optional(), automation_budget_mode: z.enum(["block_edit", "pause_all"]).optional(), automation_history_days: z.number().int().min(0).optional(), automation_max_depth: z.number().int().min(2).max(25).optional(), mfa_required_roles: z.array(z.string().max(40)).max(20).optional(), score_decay_per_week: z.number().min(0).max(20).optional(), csat_enabled: z.boolean().optional() }), req.body) };
    const merged = { ...DEFAULT_SETTINGS, ...req.ctx.settings, ...b };
    req.ctx.db.update("workspaces", req.ctx.ws, { settings: merged, name: merged.company_name });
    audit(req.ctx, "workspace", req.ctx.ws, "update", b);
    return { settings: merged };
  }));

  // ---------- api keys ----------
  r.get("/api-keys", h(async (req) => { assertAdmin(req.ctx); return { items: req.ctx.db.all("SELECT k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.created_at, k.revoked_at, u.name user_name FROM api_keys k LEFT JOIN users u ON u.id=k.user_id WHERE k.workspace_id=? ORDER BY k.created_at DESC", req.ctx.ws) }; }));
  r.post("/api-keys", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ name: z.string().trim().min(1), scopes: z.enum(["read", "read,write"]).default("read,write"), user_id: z.string().optional() }), req.body);
    const raw = `crm_${token(24)}`;
    const kid = id();
    req.ctx.db.insert("api_keys", { id: kid, workspace_id: req.ctx.ws, name: b.name, key_hash: sha256(raw), prefix: raw.slice(0, 10), user_id: b.user_id ?? req.ctx.user.id, scopes: b.scopes, created_at: now() });
    audit(req.ctx, "api_key", kid, "create", { name: b.name });
    return { id: kid, key: raw, name: b.name, scopes: b.scopes };
  }));
  r.delete("/api-keys/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("UPDATE api_keys SET revoked_at=? WHERE id=? AND workspace_id=?", now(), param(req, "id"), req.ctx.ws); audit(req.ctx, "api_key", param(req, "id"), "delete"); return { ok: true }; }));

  // ---------- webhooks ----------
  r.get("/webhooks", h(async (req) => { assertAdmin(req.ctx); return { items: req.ctx.db.all<Row>("SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='failed') failed, (SELECT MAX(created_at) FROM webhook_deliveries d WHERE d.webhook_id=w.id) last_delivery FROM webhooks w WHERE workspace_id=? ORDER BY created_at DESC", req.ctx.ws).map((w) => parseJson(w, ["events"])) }; }));
  r.post("/webhooks", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ url: z.string().url(), events: z.array(z.string()).min(1), secret: z.string().min(8).optional() }), req.body);
    const wid = id();
    const secret = b.secret ?? token(24);
    req.ctx.db.insert("webhooks", { id: wid, workspace_id: req.ctx.ws, url: b.url, events: b.events, secret, active: 1, created_at: now() });
    return { ...parseJson(req.ctx.db.get<Row>("SELECT * FROM webhooks WHERE id=?", wid), ["events"]), secret };
  }));
  r.put("/webhooks/:id", h(async (req) => { assertAdmin(req.ctx); const b = parse(z.object({ url: z.string().url().optional(), events: z.array(z.string()).optional(), active: z.boolean().optional() }), req.body); req.ctx.db.update("webhooks", param(req, "id"), { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0 }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM webhooks WHERE id=?", param(req, "id")), ["events"]); }));
  r.delete("/webhooks/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("DELETE FROM webhooks WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  r.get("/webhooks/:id/deliveries", h(async (req) => { assertAdmin(req.ctx); return { items: req.ctx.db.all("SELECT id, event, status, attempts, response_code, error, next_retry_at, created_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 100", param(req, "id")) }; }));
  r.post("/webhooks/deliveries/:id/retry", h(async (req) => { assertAdmin(req.ctx); await attemptDelivery(req.ctx.db, param(req, "id")); return req.ctx.db.get("SELECT id, status, attempts, response_code, error FROM webhook_deliveries WHERE id=?", param(req, "id")); }));

  // ---------- audit ----------
  /** Verifica la cadena de hashes del registro de auditoría (detecta filas alteradas o borradas). */
  r.get("/audit/verify", h(async (req) => {
    assertAdmin(req.ctx);
    const rows = req.ctx.db.all<Row>("SELECT * FROM audit_log WHERE workspace_id=? AND seq IS NOT NULL ORDER BY seq", req.ctx.ws);
    let prev = "GENESIS"; let expected = 1;
    for (const r of rows) {
      if (r.seq !== expected) return { ok: false, checked: expected - 1, broken_at: expected, reason: `Falta la entrada ${expected} (encontrada ${r.seq})` };
      if (r.prev_hash !== prev || auditHash(prev, r) !== r.chain_hash) return { ok: false, checked: expected - 1, broken_at: r.seq, reason: "El contenido o el encadenado no coincide" };
      prev = String(r.chain_hash); expected++;
    }
    const legacy = req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE workspace_id=? AND seq IS NULL", req.ctx.ws)?.n ?? 0;
    return { ok: true, checked: rows.length, last_hash: prev, legacy_unchained: legacy };
  }));
  r.get("/audit", h(async (req) => {
    assertAdmin(req.ctx);
    const page = Number(req.query.page) || 1, size = 50;
    const where = ["a.workspace_id=?"]; const params: unknown[] = [req.ctx.ws];
    if (typeof req.query.object === "string" && req.query.object) { where.push("a.object=?"); params.push(req.query.object); }
    if (typeof req.query.action === "string" && req.query.action) { where.push("a.action=?"); params.push(req.query.action); }
    if (typeof req.query.user_id === "string" && req.query.user_id) { where.push("a.user_id=?"); params.push(req.query.user_id); }
    if (typeof req.query.q === "string" && req.query.q) { where.push("(a.record_id LIKE ? OR a.changes LIKE ?)"); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const w = where.join(" AND ");
    const total = req.ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit_log a WHERE ${w}`, ...params)?.n ?? 0;
    const items = req.ctx.db.all<Row>(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE ${w} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size).map((x) => parseJson(x, ["changes"]));
    return { items, total, page, page_size: size };
  }));

  // ---------- scoring rules ----------
  r.get("/scoring-rules", h(async (req) => ({ items: req.ctx.db.all("SELECT * FROM scoring_rules WHERE workspace_id=? ORDER BY points DESC", req.ctx.ws) })));
  r.post("/scoring-rules", h(async (req) => { assertAdmin(req.ctx); const b = parse(z.object({ label: z.string().min(1), field: z.string().min(1), op: z.string().min(1), value: z.string().nullable().optional(), points: z.number().int() }), req.body); const rid = id(); req.ctx.db.insert("scoring_rules", { id: rid, workspace_id: req.ctx.ws, ...b, value: b.value ?? null, active: 1 }); return req.ctx.db.get("SELECT * FROM scoring_rules WHERE id=?", rid); }));
  r.put("/scoring-rules/:id", h(async (req) => { assertAdmin(req.ctx); const b = parse(z.object({ label: z.string().optional(), field: z.string().optional(), op: z.string().optional(), value: z.string().nullable().optional(), points: z.number().int().optional(), active: z.boolean().optional() }), req.body); req.ctx.db.update("scoring_rules", param(req, "id"), { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0 }); return req.ctx.db.get("SELECT * FROM scoring_rules WHERE id=?", param(req, "id")); }));
  r.delete("/scoring-rules/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("DELETE FROM scoring_rules WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));

  // ---------- recycle bin ----------
  r.get("/recycle-bin", h(async (req) => ({
    contacts: req.ctx.db.all("SELECT id, first_name||' '||last_name name, email, deleted_at, merged_into FROM contacts WHERE workspace_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200", req.ctx.ws),
    companies: req.ctx.db.all("SELECT id, name, domain, deleted_at FROM companies WHERE workspace_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200", req.ctx.ws),
    deals: req.ctx.db.all("SELECT id, name, amount, deleted_at FROM deals WHERE workspace_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200", req.ctx.ws),
  })));

  // ---------- fake outbox (dev) ----------
  r.get("/outbox", h(async (req) => { assertAdmin(req.ctx); return { mode: emailMode(), items: req.ctx.db.all("SELECT e.id, e.to_email, e.subject, e.status, e.opens, e.clicks, e.sent_at, e.error, (SELECT first_name||' '||last_name FROM contacts WHERE id=e.contact_id) contact_name FROM emails e WHERE e.workspace_id=? ORDER BY e.created_at DESC LIMIT 100", req.ctx.ws), recent: sentLog.slice(-5).map((m) => ({ to: m.to, subject: m.subject })) }; }));
  r.get("/outbox/:id", h(async (req) => { assertAdmin(req.ctx); const e = req.ctx.db.get<Row>("SELECT * FROM emails WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); if (!e) throw notFound("Email"); return e; }));

  r.get("/gdpr-requests", h(async (req) => ({ items: req.ctx.db.all("SELECT g.*, u.name user_name, (SELECT first_name||' '||last_name FROM contacts WHERE id=g.contact_id) contact_name FROM gdpr_requests g LEFT JOIN users u ON u.id=g.user_id WHERE g.workspace_id=? ORDER BY g.created_at DESC LIMIT 200", req.ctx.ws) })));
  r.get("/usage", h(async (req) => {
    const db = req.ctx.db, ws = req.ctx.ws;
    const n = (q: string) => db.get<{ n: number }>(q, ws)?.n ?? 0;
    return { contacts: n("SELECT COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL"), companies: n("SELECT COUNT(*) n FROM companies WHERE workspace_id=? AND deleted_at IS NULL"), deals: n("SELECT COUNT(*) n FROM deals WHERE workspace_id=? AND deleted_at IS NULL"), activities: n("SELECT COUNT(*) n FROM activities WHERE workspace_id=?"), emails_30d: n("SELECT COUNT(*) n FROM emails WHERE workspace_id=? AND created_at > datetime('now','-30 days')"), workflow_runs_30d: n("SELECT COUNT(*) n FROM workflow_runs WHERE workspace_id=? AND ran_at > datetime('now','-30 days')"), webhook_failed: n("SELECT COUNT(*) n FROM webhook_deliveries WHERE workspace_id=? AND status='failed'"), users: n("SELECT COUNT(*) n FROM users WHERE workspace_id=? AND active=1") };
  }));
  return r;
}
