import type { Ctx, Permissions } from "../context.js";
import { forbidden } from "./errors.js";

export const OBJECTS = ["contact", "company", "deal", "task", "activity", "ticket", "product", "quote", "list", "report", "contract"] as const;
export const ACTIONS = ["create", "read", "update", "delete", "export"] as const;

export const FULL: Permissions = Object.fromEntries(OBJECTS.map((o) => [o, [...ACTIONS]])) as Permissions;

export const PRESET_ROLES: { key: string; name: string; visibility: "own" | "team" | "all"; permissions: Permissions }[] = [
  { key: "admin", name: "Administrador", visibility: "all", permissions: { ...FULL, admin: true } },
  { key: "manager", name: "Manager", visibility: "team", permissions: { ...FULL } },
  { key: "sales", name: "Comercial", visibility: "own", permissions: { ...FULL, product: ["read"], report: ["read"] } },
  { key: "marketing", name: "Marketing", visibility: "all", permissions: { ...FULL, deal: ["read"], ticket: ["read"], product: ["read"], quote: ["read"] } },
  { key: "support", name: "Soporte", visibility: "all", permissions: { ...FULL, deal: ["read"], quote: ["read"], product: ["read"] } },
  { key: "readonly", name: "Solo lectura", visibility: "all", permissions: Object.fromEntries(OBJECTS.map((o) => [o, ["read"]])) as Permissions },
];

export function can(ctx: Ctx, object: string, action: string): boolean {
  if (ctx.role.permissions.admin) return true;
  const p = ctx.role.permissions[object];
  return Array.isArray(p) && p.includes(action);
}
export function assert(ctx: Ctx, object: string, action: string) {
  if (!can(ctx, object, action)) throw forbidden(`Tu rol no permite ${describe(action)} ${object}`);
}
export const isAdmin = (ctx: Ctx) => !!ctx.role.permissions.admin;
export function assertAdmin(ctx: Ctx) {
  if (!isAdmin(ctx)) throw forbidden("Solo un administrador puede hacer esto");
}
function describe(a: string) {
  return { create: "crear", read: "ver", update: "editar", delete: "borrar", export: "exportar" }[a] ?? a;
}

/** Owner ids visible to the user, or null when everything is visible. */
export function visibleOwnerIds(ctx: Ctx): string[] | null {
  if (isAdmin(ctx) || ctx.role.visibility === "all") return null;
  if (ctx.role.visibility === "team") {
    const teamIds = ctx.db
      .all<{ id: string }>("SELECT id FROM teams WHERE workspace_id=? AND (manager_id=? OR id=?)", ctx.ws, ctx.user.id, ctx.user.team_id ?? "")
      .map((t) => t.id);
    const ids = new Set<string>([ctx.user.id]);
    if (teamIds.length) {
      for (const u of ctx.db.all<{ id: string }>(`SELECT id FROM users WHERE workspace_id=? AND team_id IN (${teamIds.map(() => "?").join(",")})`, ctx.ws, ...teamIds)) ids.add(u.id);
    }
    return [...ids];
  }
  return [ctx.user.id];
}

/** Registros compartidos expresamente con el usuario o con su equipo (record_shares), además de lo que ve su rol. */
function shareSql(ctx: Ctx, object: string, idCol: string, minAccess: "read" | "edit" = "read"): { sql: string; params: unknown[] } {
  return { sql: `${idCol} IN (SELECT record_id FROM record_shares WHERE workspace_id=? AND object=? AND (user_id=? OR (team_id IS NOT NULL AND team_id=?))${minAccess === "edit" ? " AND access='edit'" : ""})`, params: [ctx.ws, object, ctx.user.id, ctx.user.team_id ?? ""] };
}
/** Acceso concedido por compartir (null si no hay). */
export function sharedAccess(ctx: Ctx, object: string, recordId: string): "read" | "edit" | null {
  const r = ctx.db.get<{ access: string }>("SELECT access FROM record_shares WHERE workspace_id=? AND object=? AND record_id=? AND (user_id=? OR (team_id IS NOT NULL AND team_id=?)) ORDER BY access='edit' DESC LIMIT 1", ctx.ws, object, recordId, ctx.user.id, ctx.user.team_id ?? "");
  return r ? (r.access === "edit" ? "edit" : "read") : null;
}

/** SQL fragment restricting rows by owner column. Unowned records stay visible; shared records too when `share` is given. */
export function ownerScope(ctx: Ctx, col = "owner_id", share?: { object: string; idCol: string }): { sql: string; params: unknown[] } {
  const ids = visibleOwnerIds(ctx);
  if (!ids) return { sql: "1=1", params: [] };
  const base = { sql: `(${col} IS NULL OR ${col} IN (${ids.map(() => "?").join(",")}))`, params: ids as unknown[] };
  if (!share) return base;
  const s = shareSql(ctx, share.object, share.idCol);
  return { sql: `(${base.sql} OR ${s.sql})`, params: [...base.params, ...s.params] };
}
export function canSeeRecord(ctx: Ctx, ownerId: string | null | undefined, share?: { object: string; id: string }): boolean {
  const ids = visibleOwnerIds(ctx);
  if (!ids || !ownerId || ids.includes(ownerId)) return true;
  return !!share && !!sharedAccess(ctx, share.object, share.id);
}
/** Puede modificarlo: lo ve por su rol, o se lo han compartido con permiso de edición. */
export function canEditRecord(ctx: Ctx, ownerId: string | null | undefined, object: string, id: string): boolean {
  const ids = visibleOwnerIds(ctx);
  if (!ids || !ownerId || ids.includes(ownerId)) return true;
  return sharedAccess(ctx, object, id) === "edit";
}
export function assertCanEdit(ctx: Ctx, ownerId: string | null | undefined, object: string, id: string) {
  if (!canEditRecord(ctx, ownerId, object, id)) throw forbidden("Te han compartido este registro solo para consulta");
}
