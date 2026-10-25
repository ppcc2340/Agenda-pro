import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { assertAdmin } from "../lib/permissions.js";
import { id, now } from "../lib/util.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parseJson, type Row } from "../db.js";
import { audit } from "../services/audit.js";
import { emit } from "../services/events.js";
import { COLUMN_TYPES, FORMULA_FUNCTIONS, AGGREGATIONS, RELATIONS, EXTRA_TARGET_FIELDS, builtinColumns, fieldDefs, evalFormula, computeFields, cellsOf, enrichOne } from "../services/columns.js";
import { normalizeLabels, fieldDependents } from "../services/columnAdmin.js";
import { loadRecord, applyPatch, cellsToPatch, OBJECT_TABLE } from "../services/recordOps.js";
import { OBJECT_FIELDS } from "../lib/filters.js";

const OBJ = z.enum(["contact", "company", "deal", "ticket", "contract"]);
export function columnRoutes() {
  const r = Router();
  r.get("/types", h(async () => ({ types: COLUMN_TYPES, functions: FORMULA_FUNCTIONS, aggregations: AGGREGATIONS })));
  // conjuntos de etiquetas compartidos (managed columns)
  r.get("/label-sets", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT s.*, (SELECT COUNT(*) FROM custom_fields f WHERE f.workspace_id=s.workspace_id AND json_extract(f.settings,'$.label_set_id')=s.id) used_by FROM label_sets s WHERE workspace_id=? ORDER BY name", req.ctx.ws).map((x) => parseJson(x, ["labels"])) })));
  const setSchema = z.object({ name: z.string().trim().min(1).max(80), labels: z.array(z.object({ id: z.number().int().optional(), label: z.string(), color: z.string().optional(), done: z.boolean().optional() })) });
  r.post("/label-sets", h(async (req) => { assertAdmin(req.ctx); const b = parse(setSchema, req.body); const sid = id(); req.ctx.db.insert("label_sets", { id: sid, workspace_id: req.ctx.ws, name: b.name, labels: normalizeLabels(b.labels), created_at: now(), updated_at: now() }); audit(req.ctx, "label_set", sid, "create", { name: b.name }); return parseJson(req.ctx.db.get<Row>("SELECT * FROM label_sets WHERE id=?", sid), ["labels"]); }));
  r.put("/label-sets/:id", h(async (req) => {
    assertAdmin(req.ctx); const b = parse(setSchema.partial(), req.body);
    const cur = req.ctx.db.get<Row>("SELECT * FROM label_sets WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); if (!cur) throw notFound("Conjunto");
    const used = new Set<number>();
    if (b.labels) for (const f of req.ctx.db.all<Row>("SELECT object, key FROM custom_fields WHERE workspace_id=? AND json_extract(settings,'$.label_set_id')=?", req.ctx.ws, cur.id)) { const t = OBJECT_TABLE[String(f.object)]; if (t) for (const x of req.ctx.db.all<{ v: unknown }>(`SELECT DISTINCT json_extract(custom,'$.${String(f.key)}') v FROM ${t} WHERE workspace_id=?`, req.ctx.ws)) if (Number(x.v) > 0) used.add(Number(x.v)); }
    req.ctx.db.update("label_sets", String(cur.id), { name: b.name, labels: b.labels ? normalizeLabels(b.labels, used) : undefined, updated_at: now() });
    audit(req.ctx, "label_set", String(cur.id), "update", { name: b.name });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM label_sets WHERE id=?", cur.id), ["labels"]);
  }));
  r.delete("/label-sets/:id", h(async (req) => { assertAdmin(req.ctx); const n = req.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_fields WHERE workspace_id=? AND json_extract(settings,'$.label_set_id')=?", req.ctx.ws, param(req, "id"))?.n ?? 0; if (n) throw badRequest(`Lo usan ${n} columna(s)`); req.ctx.db.run("DELETE FROM label_sets WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  // esquema de un tablero: columnas nativas + personalizadas + relaciones disponibles para reflejos
  r.get("/schema/:object", h(async (req) => {
    const object = parse(OBJ, req.params.object);
    const rels = Object.entries(RELATIONS[object] ?? {}).map(([k, v]) => ({ key: k, label: v.label, target: v.target, many: v.many, fields: [...(OBJECT_FIELDS[v.target] ? Object.keys(OBJECT_FIELDS[v.target]!) : []), ...(EXTRA_TARGET_FIELDS[v.target] ?? []), ...(OBJECT_FIELDS[v.target] ? fieldDefs(req.ctx, v.target).map((d) => `custom.${d.key}`) : [])] }));
    return { builtin: builtinColumns(object), custom: fieldDefs(req.ctx, object), relations: rels };
  }));
  r.get("/dependents/:object/:key", h(async (req) => { const object = parse(OBJ, req.params.object); const d = fieldDefs(req.ctx, object).find((x) => x.key === param(req, "key")); return { items: fieldDependents(req.ctx, object, param(req, "key"), d?.label ?? param(req, "key")) }; }));
  r.post("/formula/preview", h(async (req) => {
    const b = parse(z.object({ object: OBJ, expression: z.string(), record_id: z.string().optional() }), req.body);
    const t = OBJECT_TABLE[b.object]!;
    const rid = b.record_id ?? req.ctx.db.get<{ id: string }>(`SELECT id FROM ${t} WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1`, req.ctx.ws)?.id;
    if (!rid) return { value: null, error: "No hay registros para probar" };
    const rec = loadRecord(req.ctx, b.object, rid) as Row | null; if (!rec) throw notFound();
    const defs = fieldDefs(req.ctx, b.object);
    const { values } = computeFields(req.ctx, b.object, rec, defs);
    rec.custom = { ...((rec.custom as Row) ?? {}), ...values };
    const tmp = [...defs, { id: "_", object: b.object, key: "__preview", label: "__preview", type: "formula", options: [], required: 0, default_value: null, settings: { expression: b.expression } }];
    const out = computeFields(req.ctx, b.object, rec, tmp);
    void evalFormula;
    return { value: out.values.__preview ?? null, error: out.errors.__preview ?? null, record_id: rid };
  }));
  return r;
}

/** API de celdas al estilo column_values: {id, type, title, value, text}. */
export function cellRoutes() {
  const r = Router();
  r.get("/:object/:id", h(async (req) => { const object = parse(OBJ, req.params.object); const rec = loadRecord(req.ctx, object, param(req, "id")) as Row | null; if (!rec) throw notFound(); return { id: rec.id, object, column_values: cellsOf(req.ctx, object, rec) }; }));
  /** change_column_value / change_multiple_column_values: { column_id, value } o { values: {col: valor} }. Borrar con null. */
  r.put("/:object/:id", h(async (req) => {
    const object = parse(OBJ, req.params.object);
    const b = parse(z.object({ column_id: z.string().optional(), value: z.unknown().optional(), values: z.record(z.unknown()).optional() }), req.body);
    const values = b.values ?? (b.column_id ? { [b.column_id]: b.value ?? null } : null);
    if (!values || !Object.keys(values).length) throw badRequest("Indica column_id y value, o values");
    const ro = new Set([...builtinColumns(object).filter((c) => ["creation_log", "last_updated"].includes(c.type)).map((c) => c.id), "id", "workspace_id"]);
    for (const k of Object.keys(values)) if (ro.has(k)) throw badRequest(`La columna ${k} es de solo lectura`);
    applyPatch(req.ctx, object, param(req, "id"), cellsToPatch(values));
    const rec = loadRecord(req.ctx, object, param(req, "id")) as Row;
    return { id: rec.id, column_values: cellsOf(req.ctx, object, rec) };
  }));
  /** Pulsar una columna botón: dispara las automatizaciones «cuando se pulsa el botón». */
  r.post("/:object/:id/button/:key", h(async (req) => {
    const object = parse(OBJ, req.params.object);
    const d = fieldDefs(req.ctx, object).find((x) => x.key === param(req, "key") && x.type === "button"); if (!d) throw notFound("Botón");
    const rec = loadRecord(req.ctx, object, param(req, "id")); if (!rec) throw notFound();
    enrichOne(req.ctx, object, rec as Row);
    audit(req.ctx, object, param(req, "id"), "button", { button: d.label });
    emit(req.ctx, { type: `${object}.button`, object: object as never, record: rec, meta: { button: d.key } });
    return { ok: true };
  }));
  return r;
}
