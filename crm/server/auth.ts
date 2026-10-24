import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Db, Row } from "./db.js";
import { HttpError } from "./lib/errors.js";
import { id, now, addDays, sha256 } from "./lib/util.js";
import { buildCtx } from "./services/system.js";
import type { AuthedRequest, Ctx } from "./context.js";

export const SESSION_COOKIE = "crm_session";
export const SESSION_DAYS = 7;

export function createSession(db: Db, userId: string, req: Request, pending2fa = false): string {
  const sid = id() + id().replace(/-/g, "");
  db.insert("sessions", { id: sid, user_id: userId, created_at: now(), expires_at: addDays(now(), pending2fa ? 1 / 96 : SESSION_DAYS), ip: clientIp(req), user_agent: req.headers["user-agent"]?.slice(0, 200) ?? null, pending_2fa: pending2fa ? 1 : 0 });
  return sid;
}
export function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "0", maxAge: SESSION_DAYS * 86400000, path: "/" });
}
export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0])?.trim() || req.socket.remoteAddress || "";
}

/** Resolve the authenticated user from session cookie or API key. */
export function resolveCtx(db: Db, req: Request): { ctx: Ctx | null; pending2fa?: boolean } {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const raw = auth.slice(7).trim();
    const key = db.get<Row>("SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL", sha256(raw));
    if (!key) throw new HttpError(401, "API key no válida");
    const user = db.get<Row>("SELECT * FROM users WHERE id=? AND active=1", key.user_id);
    if (!user) throw new HttpError(401, "Usuario de la API key desactivado");
    db.run("UPDATE api_keys SET last_used_at=? WHERE id=?", now(), key.id);
    const ctx = buildCtx(db, user, "apikey", clientIp(req));
    if (!String(key.scopes).includes("write") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) throw new HttpError(403, "Esta API key es de solo lectura");
    return { ctx };
  }
  const sid = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!sid) return { ctx: null };
  const s = db.get<Row>("SELECT * FROM sessions WHERE id=? AND expires_at > ?", sid, now());
  if (!s) return { ctx: null };
  const user = db.get<Row>("SELECT * FROM users WHERE id=? AND active=1", s.user_id);
  if (!user) return { ctx: null };
  if (s.pending_2fa) return { ctx: null, pending2fa: true };
  return { ctx: buildCtx(db, user, "session", clientIp(req)) };
}

export function requireAuth(db: Db): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { ctx } = resolveCtx(db, req);
      if (!ctx) throw new HttpError(401, "Inicia sesión para continuar");
      (req as AuthedRequest).ctx = ctx;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// Simple in-memory rate limiter (per key) for public endpoints and login.
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(limit: number, windowMs: number, keyFn: (req: Request) => string = clientIp): RequestHandler {
  return (req, _res, next) => {
    const k = keyFn(req);
    const t = Date.now();
    const b = buckets.get(k);
    if (!b || b.reset < t) { buckets.set(k, { n: 1, reset: t + windowMs }); return next(); }
    b.n++;
    if (b.n > limit) return next(new HttpError(429, "Demasiadas peticiones, inténtalo en unos minutos"));
    next();
  };
}
