/**
 * Objetos personalizados: cada empresa define sus propios tableros (Proyectos, Inmuebles, Vehículos, Pedidos…)
 * con nombre, icono, numeración, estados con color, propietario y relaciones con los objetos del CRM y entre sí.
 * Los registros reutilizan todo lo genérico: columnas personalizadas (fórmulas, reflejos, estados por id…),
 * celdas, filtros, permisos por rol, automatizaciones e informes.
 */
import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now } from "../lib/util.js";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors.js";
import { assert, assertAdmin, can, canSeeRecord } from "../lib/permissions.js";
import { isCustomObjectKey, CORE_BOARD_OBJECTS } from "../lib/objectKeys.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { nextCounter } from "./counters.js";
import { applyDefaults, checkRequired, registerRelationProvider, type RelationDef } from "./columns.js";
import { normalizeLabels } from "./columnAdmin.js";
import { tagsSchema, validateCustom, listRecords, type ListQuery } from "./records.js";

export interface ObjStatus { id: number; label: string; color: string; done?: boolean }
export interface ObjRelation { key: string; label: string; target: string; many: boolean; inverse_label?: string }
export interface ObjectDef { id: string; key: string; name: string; plural: string; icon: string; color: string; primary_label: string; number_prefix: string | null; number_pad: number; has_owner: boolean; statuses: ObjStatus[]; relations: ObjRelation[]; description: string | null; position: number }

/** Objetos del CRM con los que se puede relacionar un objeto personalizado. */
export const CORE_TARGETS: Record<string, { label: string; table: string; name: string; path: string }> = {
  contact: { label: "Contacto", table: "contacts", name: "first_name || ' ' || last_name", path: "/contactos" },
  company: { label: "Empresa", table: "companies", name: "name", path: "/empresas" },
  deal: { label: "Negocio", table: "deals", name: "name", path: "/negocios" },
  contract: { label: "Contrato", table: "contracts", name: "number || ' · ' || title", path: "/contratos" },
  ticket: { label: "Ticket", table: "tickets", name: "'#' || number || ' · ' || subject", path: "/tickets" },
};

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
const relationSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).optional(), label: z.string().trim().min(1).max(60), target: z.string(), many: z.boolean().default(false), inverse_label: z.string().trim().max(60).optional() });
export const objectDefSchema = z.object({
  key: z.string().regex(/^o_[a-z0-9_]{2,40}$/, "Clave o_ en minúsculas").optional(),
  name: z.string().trim().min(1, "Pon el nombre en singular").max(60),
  plural: z.string().trim().min(1, "Pon el nombre en plural").max(60),
  icon: z.string().trim().max(30).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  primary_label: z.string().trim().min(1).max(40).optional(),
  number_prefix: z.string().trim().max(10).regex(/^[A-Za-z0-9-]*$/, "Prefijo: letras, números o guiones").nullable().optional(),
  number_pad: z.number().int().min(1).max(8).optional(),
  has_owner: z.boolean().optional(),
  statuses: z.array(z.object({ id: z.number().int().optional(), label: z.string(), color: z.string().optional(), done: z.boolean().optional() })).max(40).optional(),
  relations: z.array(relationSchema).max(20).optional(),
  description: z.string().max(500).nullable().optional(),
  position: z.number().int().optional(),
});

const fromRow = (r: Row): ObjectDef => { const x = parseJson(r, ["statuses", "relations"]) as Row; return { id: String(x.id), key: String(x.key), name: String(x.name), plural: String(x.plural), icon: String(x.icon), color: String(x.color), primary_label: String(x.primary_label), number_prefix: (x.number_prefix as string | null) ?? null, number_pad: Number(x.number_pad) || 4, has_owner: !!x.has_owner, statuses: (x.statuses as ObjStatus[]) ?? [], relations: (x.relations as ObjRelation[]) ?? [], description: (x.description as string | null) ?? null, position: Number(x.position) || 0 }; };
export function listDefs(ctx: Ctx): ObjectDef[] { return ctx.db.all<Row>("SELECT * FROM custom_objects WHERE workspace_id=? ORDER BY position, name", ctx.ws).map(fromRow); }
export function getDef(ctx: Ctx, key: string): ObjectDef {
  if (!isCustomObjectKey(key)) throw notFound("Objeto");
  const r = ctx.db.get<Row>("SELECT * FROM custom_objects WHERE workspace_id=? AND key=?", ctx.ws, key);
  if (!r) throw notFound("Objeto");
  return fromRow(r);
}
export function findDef(ctx: Ctx, key: string): ObjectDef | null { try { return getDef(ctx, key); } catch { return null; } }

function validRelations(ctx: Ctx, selfKey: string, rels: z.infer<typeof relationSchema>[]): ObjRelation[] {
  const others = new Set(listDefs(ctx).map((d) => d.key)); others.add(selfKey);
  const seen = new Set<string>();
  return rels.map((r0) => {
    // «__self»: relación con el propio objeto (p. ej. subproyectos) cuando aún no se conoce su clave
    const r = r0.target === "__self" ? { ...r0, target: selfKey } : r0;
    if (!CORE_TARGETS[r.target] && !(isCustomObjectKey(r.target) && others.has(r.target))) throw badRequest(`Relación con un objeto que no existe: ${r.target}`);
    const key = r.key ?? (slug(r.label).replace(/^[^a-z]+/, "") || "rel");
    if (seen.has(key)) throw badRequest(`Relación repetida: ${r.label}`);
    seen.add(key);
    return { key, label: r.label, target: r.target, many: !!r.many, inverse_label: r.inverse_label || undefined };
  });
}
/** Los roles ven el objeto nuevo con los mismos permisos que tienen sobre los contactos (se ajusta en Ajustes → Roles). */
function grantRoles(ctx: Ctx, key: string) {
  for (const r of ctx.db.all<Row>("SELECT id, permissions FROM roles WHERE workspace_id=?", ctx.ws)) {
    const p = (parseJson(r, ["permissions"])?.permissions ?? {}) as Record<string, unknown>;
    if (p[key] !== undefined) continue;
    p[key] = Array.isArray(p.contact) ? p.contact : ["read"];
    ctx.db.update("roles", String(r.id), { permissions: p });
  }
}

export function createDef(ctx: Ctx, input: z.infer<typeof objectDefSchema>): ObjectDef {
  assertAdmin(ctx);
  const key = input.key ?? `o_${slug(input.plural || input.name).slice(0, 36)}`;
  if (!isCustomObjectKey(key)) throw badRequest("Nombre no válido para generar la clave");
  if (ctx.db.get("SELECT id FROM custom_objects WHERE workspace_id=? AND key=?", ctx.ws, key)) throw conflict(`Ya existe un objeto «${input.plural}»`);
  const statuses = normalizeLabels(input.statuses?.length ? input.statuses : [{ label: "Nuevo", color: "#579bfc" }, { label: "En curso", color: "#fdab3d" }, { label: "Hecho", color: "#00c875", done: true }]);
  const pos = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_objects WHERE workspace_id=?", ctx.ws)?.n ?? 0;
  const oid = id();
  ctx.db.insert("custom_objects", { id: oid, workspace_id: ctx.ws, key, name: input.name, plural: input.plural, icon: input.icon ?? "box", color: input.color ?? "#579bfc", primary_label: input.primary_label ?? "Nombre", number_prefix: input.number_prefix || null, number_pad: input.number_pad ?? 4, has_owner: input.has_owner === false ? 0 : 1, statuses, relations: validRelations(ctx, key, input.relations ?? []), description: input.description ?? null, position: input.position ?? pos, created_by: ctx.user.id, created_at: now(), updated_at: now() });
  grantRoles(ctx, key);
  audit(ctx, "custom_object", oid, "create", { key, name: input.plural });
  return getDef(ctx, key);
}

export function updateDef(ctx: Ctx, key: string, input: Partial<z.infer<typeof objectDefSchema>>): ObjectDef {
  assertAdmin(ctx);
  const cur = getDef(ctx, key);
  let statuses: ObjStatus[] | undefined;
  if (input.statuses) {
    const used = new Set(ctx.db.all<{ s: string }>("SELECT DISTINCT status s FROM custom_records WHERE workspace_id=? AND object_key=? AND deleted_at IS NULL AND status IS NOT NULL", ctx.ws, key).map((r) => Number(r.s)).filter((n) => n > 0));
    statuses = normalizeLabels(input.statuses, used);
  }
  const relations = input.relations ? validRelations(ctx, key, input.relations) : undefined;
  if (relations) {
    const gone = cur.relations.filter((r) => !relations.some((n) => n.key === r.key)).map((r) => r.key);
    for (const k of gone) ctx.db.run("DELETE FROM custom_links WHERE workspace_id=? AND object_key=? AND relation_key=?", ctx.ws, key, k);
  }
  ctx.db.update("custom_objects", cur.id, { name: input.name, plural: input.plural, icon: input.icon, color: input.color, primary_label: input.primary_label, number_prefix: input.number_prefix === undefined ? undefined : input.number_prefix || null, number_pad: input.number_pad, has_owner: input.has_owner === undefined ? undefined : input.has_owner ? 1 : 0, statuses, relations, description: input.description, position: input.position, updated_at: now() });
  audit(ctx, "custom_object", cur.id, "update", { key });
  return getDef(ctx, key);
}

/** Borra el objeto con sus registros, vínculos y columnas (si tiene registros pide confirmación con force). */
export function deleteDef(ctx: Ctx, key: string, force = false) {
  assertAdmin(ctx);
  const cur = getDef(ctx, key);
  const n = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_records WHERE workspace_id=? AND object_key=? AND deleted_at IS NULL", ctx.ws, key)?.n ?? 0;
  if (n && !force) throw conflict(`«${cur.plural}» tiene ${n} registro(s). Bórralo igualmente solo si ya no los necesitas`, { records: n });
  const refs = listDefs(ctx).filter((d) => d.key !== key && d.relations.some((r) => r.target === key));
  if (refs.length) throw conflict(`Lo usan las relaciones de: ${refs.map((d) => d.plural).join(", ")}. Quítalas primero`);
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM custom_links WHERE workspace_id=? AND (object_key=? OR target_object=?)", ctx.ws, key, key);
    ctx.db.run("DELETE FROM custom_records WHERE workspace_id=? AND object_key=?", ctx.ws, key);
    ctx.db.run("DELETE FROM custom_fields WHERE workspace_id=? AND object=?", ctx.ws, key);
    ctx.db.run("DELETE FROM board_configs WHERE workspace_id=? AND object=?", ctx.ws, key);
    ctx.db.run("DELETE FROM custom_objects WHERE id=?", cur.id);
  });
  audit(ctx, "custom_object", cur.id, "delete", { key, records: n });
}

/* ------------------------------------------------------------------ registros */
export const recordSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(300),
  owner_id: z.string().nullable().optional(),
  status: z.union([z.string(), z.number()]).nullable().optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  /** vínculos: {clave_relación: [ids]} */
  links: z.record(z.string(), z.array(z.string()).max(500)).optional(),
});
export type RecordInput = z.infer<typeof recordSchema>;

function statusValue(def: ObjectDef, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const hit = def.statuses.find((s) => String(s.id) === String(v)) ?? def.statuses.find((s) => s.label.toLowerCase() === String(v).toLowerCase());
  if (!hit) throw badRequest(`Estado no válido: ${String(v)}`);
  return String(hit.id);
}
function targetName(ctx: Ctx, object: string, tid: string): { name: string; exists: boolean } {
  const core = CORE_TARGETS[object];
  if (core) { const r = ctx.db.get<{ n: string }>(`SELECT ${core.name} AS n FROM ${core.table} WHERE id=? AND workspace_id=?`, tid, ctx.ws); return { name: r?.n ?? "", exists: !!r }; }
  const r = ctx.db.get<{ name: string; number: string | null }>("SELECT name, number FROM custom_records WHERE id=? AND workspace_id=? AND object_key=? AND deleted_at IS NULL", tid, ctx.ws, object);
  return { name: r ? (r.number ? `${r.number} · ${r.name}` : r.name) : "", exists: !!r };
}
/** Sustituye los vínculos de las relaciones indicadas. */
function writeLinks(ctx: Ctx, def: ObjectDef, rid: string, links: Record<string, string[]>) {
  for (const [rk, ids] of Object.entries(links)) {
    const rel = def.relations.find((r) => r.key === rk);
    if (!rel) throw badRequest(`Relación desconocida: ${rk}`);
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!rel.many && uniq.length > 1) throw badRequest(`«${rel.label}» solo admite un elemento`);
    for (const t of uniq) if (!targetName(ctx, rel.target, t).exists) throw badRequest(`No existe el elemento ${t} de «${rel.label}»`);
    ctx.db.run("DELETE FROM custom_links WHERE record_id=? AND relation_key=?", rid, rk);
    for (const t of uniq) ctx.db.insert("custom_links", { id: id(), workspace_id: ctx.ws, record_id: rid, object_key: def.key, relation_key: rk, target_object: rel.target, target_id: t, created_at: now() });
  }
}
/** Vínculos de un registro agrupados por relación: {clave: [{id, name}]} y, para relaciones de uno, `<clave>_id`. */
export function linksOf(ctx: Ctx, def: ObjectDef, rid: string): Record<string, { id: string; name: string; object: string }[]> {
  const out: Record<string, { id: string; name: string; object: string }[]> = {};
  for (const rel of def.relations) out[rel.key] = ctx.db.all<{ target_id: string }>("SELECT target_id FROM custom_links WHERE record_id=? AND relation_key=? ORDER BY created_at", rid, rel.key).map((l) => ({ id: l.target_id, object: rel.target, name: targetName(ctx, rel.target, l.target_id).name })).filter((x) => x.name !== "");
  return out;
}

const SELECT = "t.*, (SELECT name FROM users WHERE id=t.owner_id) AS owner_name";
export function getRecord(ctx: Ctx, key: string, rid: string, opts: { allowDeleted?: boolean } = {}): Row {
  assert(ctx, key, "read");
  const def = getDef(ctx, key);
  const r = parseJson(ctx.db.get<Row>(`SELECT ${SELECT} FROM custom_records t WHERE t.id=? AND t.workspace_id=? AND t.object_key=?`, rid, ctx.ws, key), ["tags", "custom"]);
  if (!r || (r.deleted_at && !opts.allowDeleted)) throw notFound(def.name);
  if (!canSeeRecord(ctx, r.owner_id as string | null)) throw forbidden(`Este ${def.name.toLowerCase()} pertenece a otro equipo`);
  return withSingleLinks(def, r, linksOf(ctx, def, rid));
}
/** Los vínculos de uno quedan también como campos <clave>_id / <clave>_name (condiciones, plantillas, reflejos). */
function withSingleLinks(def: ObjectDef, r: Row, links: Record<string, { id: string; name: string }[]>): Row {
  for (const rel of def.relations) if (!rel.many) { r[`${rel.key}_id`] = links[rel.key]?.[0]?.id ?? null; r[`${rel.key}_name`] = links[rel.key]?.[0]?.name ?? null; }
  return { ...r, links };
}
/** Carga sin comprobar permisos (motor de automatizaciones, celdas). */
export function loadCustomRecord(ctx: Ctx, key: string, rid: string): Row | null {
  const def = findDef(ctx, key); if (!def) return null;
  const r = parseJson(ctx.db.get<Row>(`SELECT ${SELECT} FROM custom_records t WHERE t.id=? AND t.workspace_id=? AND t.object_key=? AND t.deleted_at IS NULL`, rid, ctx.ws, key), ["tags", "custom"]);
  if (!r) return null;
  return withSingleLinks(def, r, linksOf(ctx, def, rid));
}

export function listCustomRecords(ctx: Ctx, key: string, q: ListQuery) {
  assert(ctx, key, "read");
  const def = getDef(ctx, key);
  const res = listRecords<Row>(ctx, key, q, { select: "(SELECT name FROM users WHERE id=t.owner_id) AS owner_name" });
  if (def.relations.length && res.items.length) {
    const ids = res.items.map((r) => r.id);
    const rows = ctx.db.all<{ record_id: string; relation_key: string; target_object: string; target_id: string }>(`SELECT record_id, relation_key, target_object, target_id FROM custom_links WHERE record_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`, ...ids);
    const names = new Map<string, string>();
    for (const it of res.items) {
      const links: Record<string, { id: string; name: string; object: string }[]> = Object.fromEntries(def.relations.map((r) => [r.key, []]));
      for (const l of rows.filter((x) => x.record_id === it.id)) {
        const k = `${l.target_object}:${l.target_id}`;
        if (!names.has(k)) names.set(k, targetName(ctx, l.target_object, l.target_id).name);
        const n = names.get(k)!; if (n) (links[l.relation_key] ??= []).push({ id: l.target_id, name: n, object: l.target_object });
      }
      it.links = links;
    }
  }
  return res;
}

export function createCustomRecord(ctx: Ctx, key: string, input: RecordInput, opts: { depth?: number; skipEvents?: boolean } = {}): Row {
  assert(ctx, key, "create");
  const def = getDef(ctx, key);
  input = applyDefaults(ctx, key, input);
  const custom = validateCustom(ctx, key, input.custom ?? {});
  const rid = id();
  const number = def.number_prefix ? `${def.number_prefix}-${String(nextCounter(ctx.db, ctx.ws, `obj:${key}`)).padStart(def.number_pad, "0")}` : null;
  const row = { id: rid, workspace_id: ctx.ws, object_key: key, name: input.name, number, owner_id: def.has_owner ? (input.owner_id === undefined ? ctx.user.id : input.owner_id) : null, status: statusValue(def, input.status ?? def.statuses[0]?.id ?? null), tags: input.tags ?? [], custom, created_by: ctx.user.id, created_at: now(), updated_at: now() };
  ctx.db.transaction(() => { ctx.db.insert("custom_records", row); if (input.links) writeLinks(ctx, def, rid, input.links); });
  audit(ctx, key, rid, "create", { name: row.name, number });
  const rec = loadCustomRecord(ctx, key, rid)!;
  if (!opts.skipEvents) emit(ctx, { type: `${key}.created`, object: key as never, record: rec, depth: opts.depth });
  return getRecord(ctx, key, rid);
}

export function updateCustomRecord(ctx: Ctx, key: string, rid: string, patch: Partial<RecordInput>, opts: { depth?: number } = {}): Row {
  assert(ctx, key, "update");
  const def = getDef(ctx, key);
  const prev = getRecord(ctx, key, rid);
  const prevLoaded = loadCustomRecord(ctx, key, rid)!;
  const data: Row = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.owner_id !== undefined && def.has_owner) data.owner_id = patch.owner_id;
  if (patch.status !== undefined) data.status = statusValue(def, patch.status);
  if (patch.tags !== undefined) data.tags = patch.tags;
  if (patch.custom) data.custom = validateCustom(ctx, key, patch.custom, prev.custom as Record<string, unknown>, true);
  checkRequired(ctx, key, prev, data);
  const changes = diff(prev, data);
  const linkChanges: Record<string, [unknown, unknown]> = {};
  if (patch.links) for (const [rk, ids] of Object.entries(patch.links)) { const before = ((prev.links as Record<string, { id: string }[]>)[rk] ?? []).map((x) => x.id); if (JSON.stringify([...before].sort()) !== JSON.stringify([...new Set(ids)].sort())) linkChanges[`links.${rk}`] = [before, ids]; }
  if (!Object.keys(changes).length && !Object.keys(linkChanges).length) return prev;
  ctx.db.transaction(() => { if (Object.keys(changes).length) ctx.db.update("custom_records", rid, { ...data, updated_at: now() }); else ctx.db.update("custom_records", rid, { updated_at: now() }); if (patch.links) writeLinks(ctx, def, rid, patch.links); });
  const all = { ...changes, ...linkChanges };
  audit(ctx, key, rid, "update", all);
  emit(ctx, { type: `${key}.updated`, object: key as never, record: loadCustomRecord(ctx, key, rid)!, previous: prevLoaded, changes: all, depth: opts.depth });
  return getRecord(ctx, key, rid);
}

export function deleteCustomRecord(ctx: Ctx, key: string, rid: string) {
  assert(ctx, key, "delete");
  const r = getRecord(ctx, key, rid);
  ctx.db.update("custom_records", rid, { deleted_at: now(), updated_at: now() });
  audit(ctx, key, rid, "delete", { name: r.name });
  emit(ctx, { type: `${key}.deleted`, object: key as never, record: r });
}
export function restoreCustomRecord(ctx: Ctx, key: string, rid: string) {
  assert(ctx, key, "delete");
  getRecord(ctx, key, rid, { allowDeleted: true });
  ctx.db.update("custom_records", rid, { deleted_at: null, updated_at: now() });
  audit(ctx, key, rid, "restore", {});
  return getRecord(ctx, key, rid);
}

/** Registros personalizados vinculados a un elemento (lado inverso): agrupados por objeto y relación. */
export function relatedRecords(ctx: Ctx, object: string, rid: string) {
  const out: { object: string; name: string; plural: string; color: string; icon: string; relation: string; label: string; items: Row[] }[] = [];
  for (const def of listDefs(ctx)) {
    if (!can(ctx, def.key, "read")) continue;
    for (const rel of def.relations.filter((r) => r.target === object)) {
      const items = ctx.db.all<Row>(`SELECT t.id, t.name, t.number, t.status, t.owner_id, (SELECT name FROM users WHERE id=t.owner_id) owner_name FROM custom_links l JOIN custom_records t ON t.id=l.record_id WHERE l.workspace_id=? AND l.object_key=? AND l.relation_key=? AND l.target_id=? AND t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT 200`, ctx.ws, def.key, rel.key, rid).filter((t) => canSeeRecord(ctx, t.owner_id as string | null));
      out.push({ object: def.key, name: def.name, plural: def.plural, color: def.color, icon: def.icon, relation: rel.key, label: rel.inverse_label || def.plural, items: items.map((t) => ({ ...t, status_label: def.statuses.find((s) => String(s.id) === String(t.status)) ?? null })) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ relaciones para reflejos y automatizaciones */
const coreRows = (ctx: Ctx, object: string, ids: string[]): Row[] => {
  const core = CORE_TARGETS[object]; if (!ids.length) return [];
  if (core) return ctx.db.all<Row>(`SELECT * FROM ${core.table} WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map((r) => parseJson(r, ["tags", "custom"]) as Row);
  return ctx.db.all<Row>(`SELECT * FROM custom_records WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL`, ...ids).map((r) => parseJson(r, ["tags", "custom"]) as Row);
};
/** Relaciones dinámicas: las de un objeto personalizado y las inversas que apuntan a cualquier objeto. */
export function customRelations(ctx: Ctx, object: string): Record<string, RelationDef> {
  const out: Record<string, RelationDef> = {};
  const defs = listDefs(ctx);
  const own = defs.find((d) => d.key === object);
  if (own) for (const rel of own.relations) out[rel.key] = { label: rel.label, target: rel.target, many: rel.many, rows: (c, r) => coreRows(c, rel.target, c.db.all<{ target_id: string }>("SELECT target_id FROM custom_links WHERE record_id=? AND relation_key=?", r.id, rel.key).map((x) => x.target_id)) };
  for (const d of defs) for (const rel of d.relations.filter((r) => r.target === object)) {
    out[`inv_${d.key}_${rel.key}`] = { label: rel.inverse_label || d.plural, target: d.key, many: true, rows: (c, r) => coreRows(c, d.key, c.db.all<{ record_id: string }>("SELECT record_id FROM custom_links WHERE workspace_id=? AND object_key=? AND relation_key=? AND target_id=?", c.ws, d.key, rel.key, r.id).map((x) => x.record_id)) };
  }
  return out;
}

export const isCoreTarget = (o: string) => (CORE_BOARD_OBJECTS as readonly string[]).includes(o);

registerRelationProvider(customRelations);
