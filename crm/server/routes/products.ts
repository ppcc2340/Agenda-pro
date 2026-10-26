import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { quotePdf } from "../services/quotePdf.js";
import { audit } from "../services/audit.js";
import type { AuthedRequest } from "../context.js";
import { productSchema, quoteSchema, createQuote, getQuote, sendQuote, updateQuoteStatus } from "../services/quotes.js";
import { assert } from "../lib/permissions.js";
import { id, now } from "../lib/util.js";
import { notFound } from "../lib/errors.js";
import type { Row } from "../db.js";

export function productRoutes() {
  const r = Router();
  r.get("/", h(async (req) => { assert(req.ctx, "product", "read"); return { items: req.ctx.db.all("SELECT * FROM products WHERE workspace_id=? ORDER BY active DESC, name", req.ctx.ws) }; }));
  r.post("/", h(async (req) => {
    assert(req.ctx, "product", "create");
    const b = parse(productSchema, req.body);
    const pid = id();
    req.ctx.db.insert("products", { id: pid, workspace_id: req.ctx.ws, sku: b.sku ?? null, name: b.name, description: b.description ?? null, unit_price: b.unit_price, currency: b.currency ?? req.ctx.settings.currency, tax_rate: b.tax_rate ?? 21, cost: b.cost ?? null, category: b.category ?? null, unit: b.unit ?? "ud", billing_period: b.billing_period ?? "one_time", active: b.active === false ? 0 : 1, created_at: now() });
    return req.ctx.db.get("SELECT * FROM products WHERE id=?", pid);
  }));
  r.put("/:id", h(async (req) => {
    assert(req.ctx, "product", "update");
    const b = parse(productSchema.partial(), req.body);
    const p = req.ctx.db.get<Row>("SELECT id FROM products WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!p) throw notFound("Producto");
    req.ctx.db.update("products", p.id as string, { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0 });
    return req.ctx.db.get("SELECT * FROM products WHERE id=?", p.id);
  }));
  r.delete("/:id", h(async (req) => { assert(req.ctx, "product", "delete"); req.ctx.db.run("UPDATE products SET active=0 WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  return r;
}

export function quoteRoutes() {
  const r = Router();
  r.get("/", h(async (req) => { assert(req.ctx, "quote", "read"); return { items: req.ctx.db.all("SELECT q.id, q.number, q.version, q.status, q.total, q.date, q.valid_until, q.views, q.deal_id, d.name deal_name, (SELECT name FROM companies WHERE id=d.company_id) company_name FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.workspace_id=? ORDER BY q.created_at DESC LIMIT 500", req.ctx.ws) }; }));
  r.post("/", h(async (req) => createQuote(req.ctx, parse(quoteSchema, req.body))));
  r.get("/:id", h(async (req) => { assert(req.ctx, "quote", "read"); return getQuote(req.ctx, param(req, "id")); }));
  /** PDF del presupuesto (descarga). */
  r.get("/:id/pdf", async (req0, res, next) => {
    const req = req0 as unknown as AuthedRequest;
    try {
      assert(req.ctx, "quote", "read");
      const q = getQuote(req.ctx, param(req, "id"));
      q.currency = req.ctx.db.get<{ currency: string }>("SELECT currency FROM deals WHERE id=?", q.deal_id)?.currency;
      const out = quotePdf(req.ctx, q);
      audit(req.ctx, "quote", String(q.id), "export", { pdf: true, sha256: out.sha256 });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${out.filename}"`);
      res.setHeader("x-content-sha256", out.sha256);
      res.send(out.pdf);
    } catch (e) { next(e); }
  });
  r.post("/:id/send", h(async (req) => sendQuote(req.ctx, param(req, "id"), parse(z.object({ to: z.string().email(), message: z.string().nullable().optional() }), req.body).to, req.body?.message)));
  r.post("/:id/status", h(async (req) => updateQuoteStatus(req.ctx, param(req, "id"), parse(z.object({ status: z.string() }), req.body).status)));
  return r;
}
