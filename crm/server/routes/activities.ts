import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { activitySchema, logActivity } from "../services/activities.js";
import { assert } from "../lib/permissions.js";
import { notFound, forbidden } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { sendMail } from "../services/email.js";
import { renderTemplate } from "../lib/util.js";
import { getContact } from "../services/contacts.js";
import type { Row } from "../db.js";

export function activityRoutes() {
  const r = Router();
  r.post("/", h(async (req) => { assert(req.ctx, "activity", "create"); return logActivity(req.ctx, parse(activitySchema, req.body)); }));
  r.put("/:id", h(async (req) => {
    assert(req.ctx, "activity", "update");
    const a = req.ctx.db.get<Row>("SELECT * FROM activities WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!a) throw notFound("Actividad");
    if (a.type === "system") throw forbidden("Las entradas del sistema no se editan");
    const b = parse(activitySchema.partial(), req.body);
    req.ctx.db.update("activities", a.id as string, { subject: b.subject, body: b.body, outcome: b.outcome, pinned: b.pinned === undefined ? undefined : b.pinned ? 1 : 0, duration_min: b.duration_min, occurred_at: b.occurred_at });
    return req.ctx.db.get("SELECT * FROM activities WHERE id=?", a.id);
  }));
  r.delete("/:id", h(async (req) => {
    assert(req.ctx, "activity", "delete");
    const a = req.ctx.db.get<Row>("SELECT * FROM activities WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!a) throw notFound("Actividad");
    if (a.type === "system") throw forbidden("Las entradas del sistema no se borran");
    req.ctx.db.run("DELETE FROM activities WHERE id=?", a.id);
    audit(req.ctx, "activity", a.id as string, "delete", { subject: a.subject });
    return { ok: true };
  }));
  /** Send an email to a contact from the CRM (7.1) with template variables and open/click tracking. */
  r.post("/send-email", h(async (req) => {
    assert(req.ctx, "activity", "create");
    const b = parse(z.object({ contact_id: z.string(), to: z.string().email().optional(), subject: z.string().min(1), body: z.string().min(1), template_id: z.string().optional(), deal_id: z.string().nullable().optional(), ticket_id: z.string().nullable().optional() }), req.body);
    const c = getContact(req.ctx, b.contact_id);
    if (c.do_not_contact) throw forbidden("El contacto ha pedido no ser contactado");
    const to = b.to ?? (c.email as string | null);
    if (!to) throw notFound("Email del contacto");
    const vars = { nombre: c.first_name, apellidos: c.last_name, name: `${c.first_name} ${c.last_name}`.trim(), empresa: c.company_name ?? "", email: c.email, cargo: c.job_title ?? "", propietario: { nombre: req.ctx.user.name, firma: req.ctx.user.email_signature ?? "" }, owner: { name: req.ctx.user.name, signature: req.ctx.user.email_signature ?? "" }, contact: c };
    const subject = renderTemplate(b.subject, vars);
    const body = renderTemplate(b.body, vars);
    const a = logActivity(req.ctx, { type: "email", subject, body, direction: "outbound", contact_id: c.id as string, deal_id: b.deal_id ?? null, ticket_id: b.ticket_id ?? null, meta: { to, template_id: b.template_id ?? null } });
    const emailId = await sendMail(req.ctx.db, req.ctx.ws, { to, subject, html: body.includes("<") ? body : body.replace(/\n/g, "<br/>"), contactId: c.id as string, userId: req.ctx.user.id, activityId: a.id as string, fromName: req.ctx.user.name });
    return { activity: a, email_id: emailId };
  }));
  return r;
}
