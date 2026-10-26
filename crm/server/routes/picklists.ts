/** Listas de valores (etiquetas de los campos del sistema): consulta y edición completa. */
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { assert } from "../lib/permissions.js";
import { badRequest } from "../lib/errors.js";
import { allPicklists, picklistDef, picklistInfo, savePicklist } from "../services/picklists.js";
import { applyPatch } from "../services/recordOps.js";

const saveSchema = z.object({
  options: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().max(60), color: z.string().max(20), role: z.string().max(40), hidden: z.boolean().optional() })).min(1).max(100),
  reassign: z.record(z.string(), z.string()).optional(),
});

export function picklistRoutes() {
  const r = Router();
  r.get("/", h(async (req) => ({ items: allPicklists(req.ctx) })));
  r.get("/:key", h(async (req) => { const d = picklistDef(param(req, "key")); if (!d) throw badRequest("Lista no encontrada"); return picklistInfo(req.ctx, d); }));
  r.put("/:key", h(async (req) => {
    const d = picklistDef(param(req, "key")); if (!d) throw badRequest("Lista no encontrada");
    if (!req.ctx.role.permissions.admin) assert(req.ctx, ["obligation", "milestone"].includes(d.object) ? "contract" : d.object, "update");
    const b = parse(saveSchema, req.body);
    if (d.key === "deal.status") for (const [from, to] of Object.entries(b.reassign ?? {})) {
      const before = picklistInfo(req.ctx, d).options; const f = before.find((o) => o.id === from); const t = b.options.find((o) => o.id === to);
      if (f && t && f.role !== t.role) throw badRequest("Los negocios solo se mueven entre etiquetas del mismo estado (para ganar o perder un negocio usa su etapa)");
    }
    return savePicklist(req.ctx, d.key, b, (ctx, object, rid, patch) => applyPatch(ctx, object, rid, patch));
  }));
  return r;
}
