import type { Ctx, Permissions } from "../context.js";
import { forbidden } from "./errors.js";

export const OBJECTS = ["contact", "company", "deal", "task", "activity", "ticket", "product", "quote", "list", "report"] as const;
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

/** SQL fragment restricting rows by owner column. Unowned records stay visible. */
export function ownerScope(ctx: Ctx, col = "owner_id"): { sql: string; params: unknown[] } {
  const ids = visibleOwnerIds(ctx);
  if (!ids) return { sql: "1=1", params: [] };
  return { sql: `(${col} IS NULL OR ${col} IN (${ids.map(() => "?").join(",")}))`, params: ids };
}
export function canSeeRecord(ctx: Ctx, ownerId: string | null | undefined): boolean {
  const ids = visibleOwnerIds(ctx);
  return !ids || !ownerId || ids.includes(ownerId);
}
