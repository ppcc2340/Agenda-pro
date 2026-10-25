import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db.js";
import { parseJson } from "../db.js";
import { h, parse, param } from "./_helpers.js";
import { HttpError } from "../lib/errors.js";
import { verifyPassword, hashPassword, now, addDays, totpVerify, newTotpSecret, id } from "../lib/util.js";
import { createSession, setSessionCookie, SESSION_COOKIE, clientIp, rateLimit, requireAuth, resolveCtx } from "../auth.js";
import { buildCtx } from "../services/system.js";
import { audit } from "../services/audit.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export function authRoutes(db: Db) {
  const r = Router();

  r.post("/login", rateLimit(20, 15 * 60000), h(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = db.get<Row>("SELECT * FROM users WHERE email=?", email.toLowerCase().trim());
    const fail = () => { throw new HttpError(401, "Email o contraseña incorrectos"); };
    if (!user || !user.active || user.is_service) fail();
    const u = user as Row;
    if (u.locked_until && (u.locked_until as string) > now()) throw new HttpError(423, "Cuenta bloqueada temporalmente por intentos fallidos. Espera 15 minutos");
    if (!verifyPassword(password, u.password_hash as string)) {
      const failed = (u.failed_logins as number) + 1;
      db.update("users", u.id as string, { failed_logins: failed, locked_until: failed >= 5 ? addDays(now(), 15 / 1440) : null });
      db.insert("audit_log", { id: id(), workspace_id: u.workspace_id, user_id: u.id, object: "user", record_id: u.id, action: "login_failed", changes: {}, ip: clientIp(req), created_at: now() });
      fail();
    }
    db.update("users", u.id as string, { failed_logins: 0, locked_until: null, last_login_at: now() });
    const pending = !!u.totp_enabled;
    const sid = createSession(db, u.id as string, req, pending);
    setSessionCookie(res, sid);
    if (pending) return { requires_2fa: true };
    db.insert("audit_log", { id: id(), workspace_id: u.workspace_id, user_id: u.id, object: "user", record_id: u.id, action: "login", changes: {}, ip: clientIp(req), created_at: now() });
    return { ok: true, user: publicUser(db, u) };
  }));

  r.post("/2fa", rateLimit(10, 15 * 60000), h(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    const sid = (req as unknown as { cookies: Record<string, string> }).cookies?.[SESSION_COOKIE];
    const s = sid ? db.get<Row>("SELECT * FROM sessions WHERE id=? AND pending_2fa=1 AND expires_at > ?", sid, now()) : undefined;
    if (!s) throw new HttpError(401, "Vuelve a iniciar sesión");
    const u = db.get<Row>("SELECT * FROM users WHERE id=?", s.user_id);
    if (!u || !totpVerify(u.totp_secret as string, code)) throw new HttpError(401, "Código incorrecto");
    db.update("sessions", s.id as string, { pending_2fa: 0, expires_at: addDays(now(), 7) });
    setSessionCookie(res, s.id as string);
    db.insert("audit_log", { id: id(), workspace_id: u.workspace_id, user_id: u.id, object: "user", record_id: u.id, action: "login", changes: { totp: true }, ip: clientIp(req), created_at: now() });
    return { ok: true, user: publicUser(db, u) };
  }));

  r.post("/logout", h(async (req, res) => {
    const sid = (req as unknown as { cookies: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (sid) db.run("DELETE FROM sessions WHERE id=?", sid);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }));

  r.get("/me", h(async (req) => {
    const { ctx, pending2fa } = resolveCtx(db, req);
    if (!ctx) return { user: null, requires_2fa: !!pending2fa };
    return { user: publicUser(db, ctx.user), role: ctx.role, settings: ctx.settings, workspace: db.get("SELECT id, name FROM workspaces WHERE id=?", ctx.ws) };
  }));

  const auth = requireAuth(db);

  r.put("/me", auth, h(async (req) => {
    const ctx = req.ctx;
    const body = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), email_signature: z.string().max(2000).nullable().optional(), notification_prefs: z.record(z.unknown()).optional() }), req.body);
    db.update("users", ctx.user.id, body);
    return { user: publicUser(db, db.get<Row>("SELECT * FROM users WHERE id=?", ctx.user.id)!) };
  }));

  r.post("/password", auth, h(async (req) => {
    const ctx = req.ctx;
    const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(10, "Mínimo 10 caracteres").regex(/[A-Z]/, "Incluye una mayúscula").regex(/[0-9]/, "Incluye un número") }), req.body);
    const u = db.get<Row>("SELECT password_hash FROM users WHERE id=?", ctx.user.id)!;
    if (!verifyPassword(current, u.password_hash as string)) throw new HttpError(400, "La contraseña actual no es correcta");
    db.update("users", ctx.user.id, { password_hash: hashPassword(next) });
    audit(ctx, "user", ctx.user.id, "update", { password: true });
    return { ok: true };
  }));

  r.post("/2fa/setup", auth, h(async (req) => {
    const ctx = req.ctx;
    const secret = newTotpSecret();
    db.update("users", ctx.user.id, { totp_secret: secret, totp_enabled: 0 });
    const issuer = encodeURIComponent(ctx.settings.company_name || "CRM");
    return { secret, otpauth: `otpauth://totp/${issuer}:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
  }));
  r.post("/2fa/enable", auth, h(async (req) => {
    const ctx = req.ctx;
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const u = db.get<Row>("SELECT totp_secret FROM users WHERE id=?", ctx.user.id)!;
    if (!u.totp_secret || !totpVerify(u.totp_secret as string, code)) throw new HttpError(400, "Código incorrecto. Comprueba la hora del móvil");
    db.update("users", ctx.user.id, { totp_enabled: 1 });
    audit(ctx, "user", ctx.user.id, "update", { totp_enabled: [0, 1] });
    return { ok: true };
  }));
  r.post("/2fa/disable", auth, h(async (req) => {
    const ctx = req.ctx;
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const u = db.get<Row>("SELECT password_hash FROM users WHERE id=?", ctx.user.id)!;
    if (!verifyPassword(password, u.password_hash as string)) throw new HttpError(400, "Contraseña incorrecta");
    db.update("users", ctx.user.id, { totp_enabled: 0, totp_secret: null });
    audit(ctx, "user", ctx.user.id, "update", { totp_enabled: [1, 0] });
    return { ok: true };
  }));

  r.get("/sessions", auth, h(async (req) => ({ items: db.all("SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id=? AND expires_at > ? ORDER BY created_at DESC", req.ctx.user.id, now()) })));
  r.delete("/sessions/:id", auth, h(async (req) => { db.run("DELETE FROM sessions WHERE id=? AND user_id=?", param(req, "id"), req.ctx.user.id); return { ok: true }; }));
  r.delete("/sessions", auth, h(async (req, res) => {
    db.run("DELETE FROM sessions WHERE user_id=?", req.ctx.user.id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }));
  return r;
}

export function publicUser(db: Db, u: Row) {
  parseJson(u, ["notification_prefs"]);
  const role = db.get<Row>("SELECT key, name, visibility, permissions FROM roles WHERE id=?", u.role_id);
  parseJson(role, ["permissions"]);
  const team = u.team_id ? db.get<Row>("SELECT id, name FROM teams WHERE id=?", u.team_id) : null;
  return { id: u.id, name: u.name, email: u.email, role_id: u.role_id, role, team, team_id: u.team_id, totp_enabled: !!u.totp_enabled, email_signature: u.email_signature, notification_prefs: u.notification_prefs ?? {}, quota: u.quota, last_login_at: u.last_login_at, active: !!u.active, created_at: u.created_at };
}

export { buildCtx };
