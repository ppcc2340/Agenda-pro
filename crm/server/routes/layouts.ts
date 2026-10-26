/**
 * /api/layouts (diseño de fichas), /api/field-permissions (seguridad por campo) y /api/shares (compartir
 * registros), más el guardián que aplica la seguridad por campo a todas las rutas de objetos.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { assertAdmin, assert, assertCanEdit, isAdmin } from "../lib/permissions.js";
import { badRequest, notFound } from "../lib/errors.js";
import { id, now } from "../lib/util.js";
import type { Row } from "../db.js";
import type { AuthedRequest, Ctx } from "../context.js";
import { audit } from "../services/audit.js";
import { notify } from "../services/notifications.js";
import { effectiveLayout, saveLayout, defaultLayout, listLayouts, assertCreateRequired, LAYOUT_OBJECTS } from "../services/layouts.js";
import { fieldCatalog, accessMap, clearAccessCache, SECURED_OBJECTS, touchedFields, assertWritable, redact } from "../services/fieldSecurity.js";
import { OBJECT_TABLE } from "../services/recordOps.js";

const OBJ = z.enum(LAYOUT_OBJECTS);
const SHARE_OBJ = z.enum(["contact", "company", "deal", "contract", "ticket"]);
const PATHS: Record<string, string> = { contact: "contactos", company: "empresas", deal: "negocios", contract: "contratos", ticket: "tickets" };

export function layoutRoutes() {
  const r = Router();
  // ---------- diseño de fichas ----------
  r.get("/layouts/:object", h(async (req) => { const object = parse(OBJ, req.params.object); return effectiveLayout(req.ctx, object); }));
  /** Para el editor (admin): diseño guardado de un rol (o el general), catálogo completo y diseños existentes. */
  r.get("/layouts/:object/edit", h(async (req) => {
    assertAdmin(req.ctx);
    const object = parse(OBJ, req.params.object);
    const roleId = req.query.role_id ? String(req.query.role_id) : null;
    const ownRow = req.ctx.db.get<Row>(`SELECT config FROM layouts WHERE workspace_id=? AND object=? AND ${roleId ? "role_id=?" : "role_id IS NULL"}`, ...(roleId ? [req.ctx.ws, object, roleId] : [req.ctx.ws, object]));
    const generalRow = roleId ? req.ctx.db.get<Row>("SELECT config FROM layouts WHERE workspace_id=? AND object=? AND role_id IS NULL", req.ctx.ws, object) : null;
    const pick = ownRow ?? generalRow;
    return { layout: pick ? JSON.parse(String(pick.config)) : defaultLayout(req.ctx, object), own: !!ownRow, inherits: ownRow ? null : generalRow ? "default" : "generated", catalog: fieldCatalog(req.ctx, object), layouts: listLayouts(req.ctx, object) };
  }));
  r.put("/layouts/:object", h(async (req) => {
    assertAdmin(req.ctx);
    const object = parse(OBJ, req.params.object);
    const b = parse(z.object({ role_id: z.string().nullable().optional(), config: z.unknown() }), req.body);
    if (b.role_id && !req.ctx.db.get("SELECT id FROM roles WHERE id=? AND workspace_id=?", b.role_id, req.ctx.ws)) throw notFound("Rol");
    const layout = saveLayout(req.ctx, object, b.role_id ?? null, b.config);
    audit(req.ctx, "layout", object, "update", { role_id: b.role_id ?? null, sections: layout.sections.length });
    return { layout };
  }));
  r.delete("/layouts/:object", h(async (req) => {
    assertAdmin(req.ctx);
    const object = parse(OBJ, req.params.object);
    const roleId = req.query.role_id ? String(req.query.role_id) : null;
    req.ctx.db.run(`DELETE FROM layouts WHERE workspace_id=? AND object=? AND ${roleId ? "role_id=?" : "role_id IS NULL"}`, ...(roleId ? [req.ctx.ws, object, roleId] : [req.ctx.ws, object]));
    audit(req.ctx, "layout", object, "delete", { role_id: roleId });
    return { ok: true };
  }));

  // ---------- seguridad por campo ----------
  r.get("/field-permissions/me", h(async (req) => Object.fromEntries(SECURED_OBJECTS.map((o) => [o, Object.fromEntries(accessMap(req.ctx, o))]))));
  r.get("/field-permissions", h(async (req) => {
    assertAdmin(req.ctx);
    const roleId = String(req.query.role_id ?? "");
    const rows = roleId ? req.ctx.db.all<{ object: string; field: string; access: string }>("SELECT object, field, access FROM field_permissions WHERE workspace_id=? AND role_id=?", req.ctx.ws, roleId) : [];
    return { objects: SECURED_OBJECTS.map((o) => ({ object: o, fields: fieldCatalog(req.ctx, o), access: Object.fromEntries(rows.filter((x) => x.object === o).map((x) => [x.field, x.access])) })) };
  }));
  r.put("/field-permissions", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(z.object({ role_id: z.string(), object: z.enum(SECURED_OBJECTS), fields: z.record(z.string(), z.enum(["edit", "read", "hidden"])) }), req.body);
    const role = req.ctx.db.get<Row>("SELECT * FROM roles WHERE id=? AND workspace_id=?", b.role_id, req.ctx.ws); if (!role) throw notFound("Rol");
    if (String(role.permissions).includes('"admin":true')) throw badRequest("El administrador siempre tiene acceso completo");
    const keys = new Set(fieldCatalog(req.ctx, b.object).filter((f) => !f.locked).map((f) => f.key));
    req.ctx.db.transaction(() => {
      for (const [field, access] of Object.entries(b.fields)) {
        if (!keys.has(field)) continue;
        if (access === "edit") req.ctx.db.run("DELETE FROM field_permissions WHERE workspace_id=? AND role_id=? AND object=? AND field=?", req.ctx.ws, b.role_id, b.object, field);
        else req.ctx.db.run("INSERT INTO field_permissions (workspace_id, role_id, object, field, access) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, role_id, object, field) DO UPDATE SET access=excluded.access", req.ctx.ws, b.role_id, b.object, field, access);
      }
    });
    clearAccessCache(req.ctx);
    audit(req.ctx, "role", b.role_id, "permission", { object: b.object, fields: b.fields });
    return { ok: true };
  }));

  // ---------- compartir registros ----------
  const recordOwner = (ctx: Ctx, object: string, rid: string) => {
    const t = OBJECT_TABLE[object]!;
    const row = ctx.db.get<Row>(`SELECT id, ${object === "ticket" ? "assignee_id" : "owner_id"} AS owner FROM ${t} WHERE id=? AND workspace_id=?`, rid, ctx.ws);
    if (!row) throw notFound();
    return row.owner as string | null;
  };
  r.get("/shares/:object/:id", h(async (req) => {
    const object = parse(SHARE_OBJ, req.params.object);
    recordOwner(req.ctx, object, param(req, "id"));
    return { items: req.ctx.db.all<Row>("SELECT s.*, u.name AS user_name, tm.name AS team_name, cb.name AS created_by_name FROM record_shares s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN teams tm ON tm.id=s.team_id LEFT JOIN users cb ON cb.id=s.created_by WHERE s.workspace_id=? AND s.object=? AND s.record_id=? ORDER BY s.created_at", req.ctx.ws, object, param(req, "id")) };
  }));
  r.post("/shares/:object/:id", h(async (req) => {
    const object = parse(SHARE_OBJ, req.params.object);
    const rid = param(req, "id");
    assert(req.ctx, object, "update");
    assertCanEdit(req.ctx, recordOwner(req.ctx, object, rid), object, rid);
    const b = parse(z.object({ user_id: z.string().optional(), team_id: z.string().optional(), access: z.enum(["read", "edit"]).default("read") }).refine((x) => !!x.user_id !== !!x.team_id, "Elige una persona o un equipo"), req.body);
    if (b.user_id && !req.ctx.db.get("SELECT id FROM users WHERE id=? AND workspace_id=? AND active=1", b.user_id, req.ctx.ws)) throw notFound("Usuario");
    if (b.team_id && !req.ctx.db.get("SELECT id FROM teams WHERE id=? AND workspace_id=?", b.team_id, req.ctx.ws)) throw notFound("Equipo");
    const dup = req.ctx.db.get<Row>("SELECT id FROM record_shares WHERE workspace_id=? AND object=? AND record_id=? AND COALESCE(user_id,'')=? AND COALESCE(team_id,'')=?", req.ctx.ws, object, rid, b.user_id ?? "", b.team_id ?? "");
    if (dup) req.ctx.db.update("record_shares", String(dup.id), { access: b.access });
    else req.ctx.db.insert("record_shares", { id: id(), workspace_id: req.ctx.ws, object, record_id: rid, user_id: b.user_id ?? null, team_id: b.team_id ?? null, access: b.access, created_by: req.ctx.user.id, created_at: now() });
    audit(req.ctx, object, rid, "permission", { share: b.user_id ? { user_id: b.user_id } : { team_id: b.team_id }, access: b.access });
    if (b.user_id && b.user_id !== req.ctx.user.id) notify(req.ctx.db, req.ctx.ws, b.user_id, { type: "record_shared", title: `${req.ctx.user.name} ha compartido un registro contigo (${b.access === "edit" ? "edición" : "consulta"})`, link: `/${PATHS[object]}/${rid}` });
    return { ok: true };
  }));
  r.delete("/shares/:id", h(async (req) => {
    const s = req.ctx.db.get<Row>("SELECT * FROM record_shares WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); if (!s) throw notFound("Compartido");
    const object = String(s.object), rid = String(s.record_id);
    if (!isAdmin(req.ctx)) { assert(req.ctx, object, "update"); assertCanEdit(req.ctx, recordOwner(req.ctx, object, rid), object, rid); }
    req.ctx.db.run("DELETE FROM record_shares WHERE id=?", s.id);
    audit(req.ctx, object, rid, "permission", { unshare: s.user_id ? { user_id: s.user_id } : { team_id: s.team_id } });
    return { ok: true };
  }));
  return r;
}

/* ------------------------------------------------------------------ guardián de seguridad por campo */
const PREFIX: [RegExp, string][] = [[/^\/contacts(\/|$)/, "contact"], [/^\/companies(\/|$)/, "company"], [/^\/deals(\/|$)/, "deal"], [/^\/tickets(\/|$)/, "ticket"], [/^\/tasks(\/|$)/, "task"], [/^\/clm\/contracts(\/|$)/, "contract"]];
const CREATE_PATHS: Record<string, string> = { "/contacts": "contact", "/companies": "company", "/deals": "deal", "/tickets": "ticket", "/tasks": "task", "/clm/contracts": "contract" };
const NESTED: Record<string, string> = { contacts: "contact", companies: "company", company: "company", deals: "deal", tickets: "ticket", tasks: "task", contracts: "contract", children: "contract" };
/** Acciones cuyo cuerpo no son campos del registro (texto de una respuesta, decisión, etc.). */
const NON_FIELD_ACTIONS = /\/(reply|notes|comments|decision|decide|merge|check-duplicates|convert|anonymize|restore|complete|send|versions|approvals|envelopes|obligations|milestones|payments|transitions|renewal-decision|risk-override|amendments|products|timeline|history|gdpr-export|tree)(\/|$)/;

function redactBody(ctx: Ctx, object: string, body: unknown, depth = 0): unknown {
  if (!body || typeof body !== "object" || depth > 2) return body;
  if (Array.isArray(body)) { body.forEach((x) => redactBody(ctx, object, x, depth)); return body; }
  const b = body as Row;
  if (Array.isArray(b.items)) { (b.items as Row[]).forEach((x) => redactBody(ctx, object, x, depth + 1)); return body; }
  if (b.contract && typeof b.contract === "object" && object === "contract") redact(ctx, "contract", b.contract as Row);
  if ("id" in b || "workspace_id" in b) redact(ctx, object, b);
  for (const [k, o] of Object.entries(NESTED)) { const v = b[k]; if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && redact(ctx, o, x as Row)); else if (v && typeof v === "object" && k === "company") redact(ctx, o, v as Row); }
  return body;
}

/**
 * Aplica la seguridad por campo a las rutas de objetos: impide escribir en campos de solo lectura u ocultos
 * (incluidas ediciones en bloque, celdas e importaciones), comprueba los obligatorios del diseño al crear y
 * quita de las respuestas JSON los campos ocultos para el rol.
 */
export function fieldGuard() {
  return (req0: Request, res: Response, next: NextFunction) => {
    const req = req0 as AuthedRequest;
    const ctx = req.ctx; if (!ctx) return next();
    try {
      const path = req.path;
      let object = PREFIX.find(([re]) => re.test(path))?.[1] ?? null;
      const cells = path.match(/^\/cells\/(contact|company|deal|ticket|task|contract)(\/|$)/);
      if (cells) object = cells[1]!;
      if (path === "/imports" && req.method === "POST") { const o = String(req.body?.object ?? ""); if (SECURED_OBJECTS.includes(o as never)) assertWritable(ctx, o, Object.values((req.body?.mapping ?? {}) as Record<string, string>).filter(Boolean)); return next(); }
      if (!object) return next();
      if (["POST", "PUT", "PATCH"].includes(req.method) && !NON_FIELD_ACTIONS.test(path)) {
        const body = (req.body ?? {}) as Row;
        const isCreate = req.method === "POST" && CREATE_PATHS[path] === object;
        if (cells) {
          if (req.method === "PUT") assertWritable(ctx, object, body.values ? Object.keys(body.values as Row) : body.column_id ? [String(body.column_id)] : []);
          // el lote se filtra celda a celda en la propia ruta (columns.ts)
        } else if (/\/bulk$/.test(path)) assertWritable(ctx, object, touchedFields(body.patch));
        else if (isCreate) { assertWritable(ctx, object, touchedFields(body, { ignoreEmpty: true })); assertCreateRequired(ctx, object, body); }
        else assertWritable(ctx, object, touchedFields(body));
      }
      if (accessMap(ctx, object).size) {
        const json = res.json.bind(res);
        const o = object;
        res.json = (body: unknown) => {
          if (cells && body && typeof body === "object" && Array.isArray((body as Row).column_values)) { const m = accessMap(ctx, o); (body as Row).column_values = ((body as Row).column_values as { id: string }[]).filter((c) => m.get(c.id) !== "hidden"); return json(body); }
          return json(redactBody(ctx, o, body));
        };
      }
      next();
    } catch (e) { next(e); }
  };
}
