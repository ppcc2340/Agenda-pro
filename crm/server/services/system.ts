import type { Db } from "../db.js";
import { parseJson, type Row } from "../db.js";
import { DEFAULT_SETTINGS, type Ctx, type Role, type User, type WorkspaceSettings } from "../context.js";

export function loadSettings(db: Db, ws: string): WorkspaceSettings {
  const w = db.get<{ settings: string }>("SELECT settings FROM workspaces WHERE id=?", ws);
  let s: Partial<WorkspaceSettings> = {};
  try { s = JSON.parse(w?.settings ?? "{}"); } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS, ...s, ticket_sla_hours: { ...DEFAULT_SETTINGS.ticket_sla_hours, ...(s.ticket_sla_hours ?? {}) } };
}

export function buildCtx(db: Db, user: Row, via: "session" | "apikey", ip = ""): Ctx {
  const role = parseJson(db.get<Row>("SELECT * FROM roles WHERE id=?", user.role_id), ["permissions"]) as Role | undefined;
  if (!role) throw new Error("Rol no encontrado");
  parseJson(user, ["notification_prefs"]);
  return { db, ws: user.workspace_id as string, user: user as User, role, ip, via, settings: loadSettings(db, user.workspace_id as string) };
}

/** Context acting as the workspace's first active admin (scheduler, public forms, tracking). */
export function systemCtx(db: Db, ws: string): Ctx {
  const u = db.get<Row>("SELECT u.* FROM users u JOIN roles r ON r.id=u.role_id WHERE u.workspace_id=? AND u.active=1 AND r.key='admin' ORDER BY u.created_at LIMIT 1", ws);
  if (!u) throw new Error("No hay administrador en el workspace");
  return buildCtx(db, u, "session", "system");
}

/** Context impersonating a given user (used by workflows to act as the record owner when needed). */
export function ctxAs(db: Db, userId: string): Ctx | null {
  const u = db.get<Row>("SELECT * FROM users WHERE id=?", userId);
  return u ? buildCtx(db, u, "session", "system") : null;
}
