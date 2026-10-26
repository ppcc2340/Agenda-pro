/** API de objetos personalizados: definiciones (/api/objects) y registros (/api/records/:objeto). */
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import type { Row } from "../db.js";
import { parseJson } from "../db.js";
import { assert, can, canSeeRecord, ownerScope } from "../lib/permissions.js";
import { badRequest } from "../lib/errors.js";
import { toCsv } from "../lib/util.js";
import { isCustomObjectKey } from "../lib/objectKeys.js";
import { listQuery } from "../services/records.js";
import { audit } from "../services/audit.js";
import { enrichOne, fieldDefs, statusLabels, cellText } from "../services/columns.js";
import { logActivity } from "../services/activities.js";
import { createTask } from "../services/tasks.js";
import {
  objectDefSchema, recordSchema, listDefs, getDef, createDef, updateDef, deleteDef,
  listCustomRecords, getRecord, createCustomRecord, updateCustomRecord, deleteCustomRecord, restoreCustomRecord, relatedRecords, CORE_TARGETS,
} from "../services/customObjects.js";

const objKey = (k: string) => { if (!isCustomObjectKey(k)) throw badRequest("Objeto no válido"); return k; };
/** las respuestas llevan ya calculadas las fórmulas, reflejos y autonumeraciones */
const withComputed = (req: { ctx: Parameters<typeof enrichOne>[0] }, key: string, rec: Row) => { enrichOne(req.ctx, key, rec); return rec; };

export function objectRoutes() {
  const r = Router();
  r.get("/", h(async (req) => ({
    items: listDefs(req.ctx).filter((d) => can(req.ctx, d.key, "read") || req.ctx.role.permissions.admin).map((d) => ({ ...d, records: req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_records WHERE workspace_id=? AND object_key=? AND deleted_at IS NULL", req.ctx.ws, d.key)?.n ?? 0, permissions: { create: can(req.ctx, d.key, "create"), update: can(req.ctx, d.key, "update"), delete: can(req.ctx, d.key, "delete"), export: can(req.ctx, d.key, "export") } })),
    core_targets: Object.fromEntries(Object.entries(CORE_TARGETS).map(([k, v]) => [k, { label: v.label, path: v.path }])),
  })));
  r.post("/", h(async (req) => createDef(req.ctx, parse(objectDefSchema, req.body))));
  r.get("/:key", h(async (req) => getDef(req.ctx, objKey(param(req, "key")))));
  r.put("/:key", h(async (req) => updateDef(req.ctx, objKey(param(req, "key")), parse(objectDefSchema.partial(), req.body))));
  r.delete("/:key", h(async (req) => { deleteDef(req.ctx, objKey(param(req, "key")), req.query.force === "1"); return { ok: true }; }));
  return r;
}

export function recordRoutes() {
  const r = Router();
  /** Registros vinculados a un elemento (lado inverso de las relaciones): /api/records/related/company/:id */
  r.get("/related/:object/:id", h(async (req) => ({ groups: relatedRecords(req.ctx, param(req, "object"), param(req, "id")) })));
  /** Buscador para los selectores de vínculos: /api/records/link-search?object=company&q=ac */
  const linkSearch = h(async (req) => {
    const object = String(req.params.object ?? req.query.object ?? ""); const q = `%${String(req.query.q ?? "").trim()}%`;
    const core = CORE_TARGETS[object];
    if (core) {
      assert(req.ctx, object, "read");
      const ownerCol = object === "ticket" ? "assignee_id" : "owner_id";
      const s = ownerScope(req.ctx, ownerCol);
      const soft = object === "ticket" ? "" : " AND deleted_at IS NULL";
      return { items: req.ctx.db.all<Row>(`SELECT id, ${core.name} AS name FROM ${core.table} WHERE workspace_id=?${soft} AND ${s.sql} AND (${core.name}) LIKE ? ORDER BY updated_at DESC LIMIT 15`, req.ctx.ws, ...s.params, q) };
    }
    objKey(object); assert(req.ctx, object, "read");
    const s = ownerScope(req.ctx, "owner_id");
    return { items: req.ctx.db.all<Row>(`SELECT id, CASE WHEN number IS NOT NULL THEN number || ' · ' || name ELSE name END AS name FROM custom_records WHERE workspace_id=? AND object_key=? AND deleted_at IS NULL AND ${s.sql} AND (name LIKE ? OR number LIKE ?) ORDER BY updated_at DESC LIMIT 15`, req.ctx.ws, object, ...s.params, q, q) };
  });
  r.get("/link-search", linkSearch);
  /** misma búsqueda con el objeto en la ruta (los selectores de la tabla añaden ?q=) */
  r.get("/link-search/:object", linkSearch);

  r.get("/:object", h(async (req) => listCustomRecords(req.ctx, objKey(param(req, "object")), parse(listQuery, req.query))));
  /** las respuestas llevan ya calculadas las columnas de fórmula, reflejo y autonumeración */
  r.post("/:object", h(async (req) => { const key = objKey(param(req, "object")); return withComputed(req, key, createCustomRecord(req.ctx, key, parse(recordSchema, req.body))); }));
  r.get("/:object/export", h(async (req, res) => {
    const key = objKey(param(req, "object")); assert(req.ctx, key, "export");
    const def = getDef(req.ctx, key); const defs = fieldDefs(req.ctx, key);
    const q = parse(listQuery, { ...req.query, page: 1, page_size: 500 });
    const all: Row[] = [];
    for (let page = 1; page <= 200; page++) { const r2 = listCustomRecords(req.ctx, key, { ...q, page }); all.push(...r2.items); if (r2.items.length < q.page_size) break; }
    const rows = all.map((it) => {
      const row: Row = { numero: it.number ?? "", [def.primary_label]: it.name, estado: def.statuses.find((s) => String(s.id) === String(it.status))?.label ?? "", propietario: it.owner_name ?? "", creado: it.created_at };
      for (const rel of def.relations) row[rel.label] = ((it.links as Record<string, { name: string }[]> | undefined)?.[rel.key] ?? []).map((x) => x.name).join(", ");
      for (const d of defs) row[d.label] = cellText(req.ctx, d.type, ((it.custom as Row) ?? {})[d.key], d);
      return row;
    });
    audit(req.ctx, key, null, "export", { count: rows.length });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${def.plural.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + toCsv(rows, rows[0] ? Object.keys(rows[0]) : ["numero", def.primary_label]));
  }));
  /** Importa filas ya leídas del CSV/Excel: las columnas se reconocen por clave o por nombre visible. */
  r.post("/:object/import", h(async (req) => {
    const key = objKey(param(req, "object")); assert(req.ctx, key, "create");
    const def = getDef(req.ctx, key); const defs = fieldDefs(req.ctx, key);
    const { rows } = parse(z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }), req.body);
    const n = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const users = req.ctx.db.all<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE workspace_id=?", req.ctx.ws);
    let created = 0; const errors: { row: number; error: string }[] = [];
    rows.forEach((raw, i) => {
      try {
        const get = (...names: string[]) => { for (const [k, v] of Object.entries(raw)) if (names.some((x) => n(x) === n(k))) return v; return undefined; };
        const name = get("name", "nombre", def.primary_label);
        if (!name || !String(name).trim()) throw new Error(`Falta «${def.primary_label}»`);
        const custom: Row = {};
        for (const d of defs) { const v = get(d.key, d.label); if (v !== undefined && v !== "") custom[d.key] = d.type === "status" ? (statusLabels(req.ctx, d).find((l) => n(l.label) === n(String(v)))?.id ?? v) : ["number", "currency", "percent", "rating"].includes(d.type) ? Number(String(v).replace(/\./g, "").replace(",", ".")) : v; }
        const owner = get("propietario", "owner", "owner_email"); const ownerId = owner ? users.find((u) => n(u.name) === n(String(owner)) || n(u.email) === n(String(owner)))?.id : undefined;
        const status = get("estado", "status");
        createCustomRecord(req.ctx, key, { name: String(name).trim(), status: status ? String(status) : undefined, owner_id: ownerId, custom });
        created++;
      } catch (e) { errors.push({ row: i + 1, error: (e as Error).message }); }
    });
    audit(req.ctx, key, null, "import", { created, errors: errors.length });
    return { created, errors };
  }));
  r.post("/:object/bulk", h(async (req) => {
    const key = objKey(param(req, "object"));
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(1000), action: z.enum(["update", "delete"]), patch: recordSchema.partial().optional() }), req.body);
    let ok = 0;
    for (const rid of b.ids) { if (b.action === "delete") deleteCustomRecord(req.ctx, key, rid); else updateCustomRecord(req.ctx, key, rid, b.patch ?? {}); ok++; }
    return { ok };
  }));
  r.get("/:object/:id", h(async (req) => { const key = objKey(param(req, "object")); return withComputed(req, key, getRecord(req.ctx, key, param(req, "id"))); }));
  r.put("/:object/:id", h(async (req) => { const key = objKey(param(req, "object")); return withComputed(req, key, updateCustomRecord(req.ctx, key, param(req, "id"), parse(recordSchema.partial(), req.body))); }));
  r.patch("/:object/:id", h(async (req) => { const key = objKey(param(req, "object")); return withComputed(req, key, updateCustomRecord(req.ctx, key, param(req, "id"), parse(recordSchema.partial(), req.body))); }));
  r.delete("/:object/:id", h(async (req) => { deleteCustomRecord(req.ctx, objKey(param(req, "object")), param(req, "id")); return { ok: true }; }));
  r.post("/:object/:id/restore", h(async (req) => restoreCustomRecord(req.ctx, objKey(param(req, "object")), param(req, "id"))));
  /** Línea temporal: notas y actividades vinculadas + historial de cambios. */
  r.get("/:object/:id/timeline", h(async (req) => {
    const key = objKey(param(req, "object")); const rid = param(req, "id");
    getRecord(req.ctx, key, rid);
    const acts = req.ctx.db.all<Row>("SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.record_object=? AND a.record_id=? ORDER BY a.pinned DESC, a.occurred_at DESC LIMIT 200", req.ctx.ws, key, rid).map((a) => parseJson(a, ["meta"]));
    const history = req.ctx.db.all<Row>("SELECT a.id, a.action, a.changes, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? AND a.object=? AND a.record_id=? ORDER BY a.created_at DESC LIMIT 200", req.ctx.ws, key, rid).map((a) => parseJson(a, ["changes"]));
    const tasks = req.ctx.db.all<Row>("SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.workspace_id=? AND t.record_object=? AND t.record_id=? ORDER BY t.completed_at IS NOT NULL, t.due_at", req.ctx.ws, key, rid);
    return { activities: acts, history, tasks };
  }));
  r.post("/:object/:id/notes", h(async (req) => {
    const key = objKey(param(req, "object")); const rid = param(req, "id");
    getRecord(req.ctx, key, rid); assert(req.ctx, "activity", "create");
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000), type: z.enum(["note", "call", "meeting", "email"]).default("note"), subject: z.string().max(300).optional() }), req.body);
    return logActivity(req.ctx, { type: b.type, subject: b.subject ?? "", body: b.body, record_object: key, record_id: rid });
  }));
  r.post("/:object/:id/tasks", h(async (req) => {
    const key = objKey(param(req, "object")); const rid = param(req, "id");
    const rec = getRecord(req.ctx, key, rid);
    const b = parse(z.object({ title: z.string().trim().min(1).max(300), due_at: z.string().nullable().optional(), assignee_id: z.string().nullable().optional() }), req.body);
    return createTask(req.ctx, { title: b.title, due_at: b.due_at ?? null, assignee_id: b.assignee_id ?? (rec.owner_id as string | null) ?? req.ctx.user.id, record_object: key, record_id: rid });
  }));
  void canSeeRecord;
  return r;
}
