/**
 * Middleware transversal de la API: identificador de petición y registro estructurado, concurrencia optimista
 * (ETag / If-Match sobre updated_at) y cabeceras de seguridad (CSP, HSTS, framing).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { AuthedRequest } from "./context.js";

/** x-request-id en cada respuesta y una línea JSON por petición (LOG_REQUESTS=1 o producción). */
export function requestLog(): RequestHandler {
  const enabled = process.env.LOG_REQUESTS === "1" || process.env.NODE_ENV === "production";
  return (req, res, next) => {
    const rid = (typeof req.headers["x-request-id"] === "string" && /^[\w-]{6,64}$/.test(req.headers["x-request-id"]) ? req.headers["x-request-id"] : randomUUID());
    (req as Request & { rid?: string }).rid = rid;
    res.setHeader("x-request-id", rid);
    const url = req.originalUrl.split("?")[0] ?? req.path;
    if (!enabled || !url.startsWith("/api")) return next();
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ctx = (req as Partial<AuthedRequest>).ctx;
      process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : "info", request_id: rid, method: req.method, path: url, status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1000000n), tenant_id: ctx?.ws ?? null, user_id: ctx?.user?.id ?? null, via: ctx?.via ?? null }) + "\n");
    });
    next();
  };
}

/** Cabeceras de seguridad. Los formularios públicos (/f/) se pueden incrustar; el resto no. */
export function securityHeaders(): RequestHandler {
  const prod = process.env.NODE_ENV === "production";
  return (req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (prod) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    const embeddable = req.path.startsWith("/f/") || req.path === "/embed.js";
    if (!embeddable) res.setHeader("x-frame-options", "DENY");
    // páginas públicas generadas en servidor (presupuesto, firma, formulario) llevan scripts en línea propios y escapados
    const serverPage = embeddable || /^\/(q|s|t|csat)\//.test(req.path);
    if (!req.path.startsWith("/api")) res.setHeader("content-security-policy", `default-src 'self'; script-src 'self'${serverPage ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${embeddable ? "*" : "'none'"}`);
    next();
  };
}

const RESOURCES: Record<string, string> = { contacts: "contacts", companies: "companies", deals: "deals", tickets: "tickets", tasks: "tasks", "clm/contracts": "contracts" };
const RE = new RegExp(`^/(${Object.keys(RESOURCES).map((k) => k.replace("/", "\\/")).join("|")})/([^/]+)$`);
export const etagOf = (updatedAt: unknown) => `"${Buffer.from(String(updatedAt)).toString("base64url")}"`;

/**
 * Concurrencia optimista: GET de un registro devuelve ETag (derivado de updated_at); PUT/PATCH/DELETE con
 * If-Match distinto responde 412 para no pisar el cambio de otra persona. Sin If-Match se comporta como antes.
 */
export function optimisticConcurrency(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const m = req.path.match(RE);
    if (!m) return next();
    const table = RESOURCES[m[1]!]!; const rid = m[2]!;
    const ctx = (req as Partial<AuthedRequest>).ctx;
    if (req.method === "GET") {
      const json = res.json.bind(res);
      res.json = (body: unknown) => { const u = body && typeof body === "object" ? ((body as Record<string, unknown>).updated_at ?? ((body as Record<string, { updated_at?: unknown }>).contract?.updated_at)) : null; if (u) res.setHeader("etag", etagOf(u)); return json(body); };
      return next();
    }
    const ifMatch = req.headers["if-match"];
    if (!ifMatch || !["PUT", "PATCH", "DELETE"].includes(req.method) || !ctx) return next();
    const row = db.get<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id=? AND workspace_id=?`, rid, ctx.ws);
    if (!row) return next();
    const tags = String(ifMatch).split(",").map((s) => s.trim().replace(/^W\//, ""));
    if (!tags.includes("*") && !tags.includes(etagOf(row.updated_at))) { res.setHeader("etag", etagOf(row.updated_at)); return res.status(412).json({ error: "El registro ha cambiado desde que lo abriste. Recarga para ver la última versión.", current_etag: etagOf(row.updated_at) }); }
    next();
  };
}
