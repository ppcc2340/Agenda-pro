import type { Request, Response, NextFunction } from "express";
import type { ZodTypeAny, z } from "zod";
import type { AuthedRequest, Ctx } from "../context.js";
import { HttpError } from "../lib/errors.js";

export type Handler = (req: AuthedRequest, res: Response) => unknown | Promise<unknown>;
/** Wrap an async handler: result is sent as JSON, errors go to the error middleware. */
export function h(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req as AuthedRequest, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };
}
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HttpError(400, issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(". "), { issues });
  }
  return r.data as z.infer<S>;
}
export const ctxOf = (req: Request): Ctx => (req as AuthedRequest).ctx;
export const param = (req: Request, name: string): string => String(req.params[name] ?? "");
