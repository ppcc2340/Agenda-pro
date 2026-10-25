import { enrichOne } from "../services/columns.js";
import { Router } from "express";
import { z } from "zod";
import { h, parse, param } from "./_helpers.js";
import { ticketSchema, listTickets, getTicket, createTicket, updateTicket, deleteTicket, replyTicket } from "../services/tickets.js";
import { listQuery } from "../services/records.js";
import { timeline } from "../services/activities.js";
import { sendMail } from "../services/email.js";

export function ticketRoutes() {
  const r = Router();
  r.get("/", h(async (req) => listTickets(req.ctx, parse(listQuery, req.query))));
  r.post("/", h(async (req) => createTicket(req.ctx, parse(ticketSchema, req.body))));
  r.get("/:id", h(async (req) => {
    const t = getTicket(req.ctx, param(req, "id"))
    enrichOne(req.ctx, "ticket", t);
    return { ...t, tasks: req.ctx.db.all("SELECT t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name FROM tasks t WHERE t.ticket_id=? AND t.completed_at IS NULL", t.id) };
  }));
  r.get("/:id/timeline", h(async (req) => ({ items: timeline(req.ctx, { ticket_id: param(req, "id") }) })));
  r.put("/:id", h(async (req) => updateTicket(req.ctx, param(req, "id"), parse(ticketSchema.partial(), req.body))));
  r.post("/:id/reply", h(async (req) => {
    const b = parse(z.object({ body: z.string().min(1), internal: z.boolean().default(false) }), req.body);
    const t = getTicket(req.ctx, param(req, "id"));
    const a = replyTicket(req.ctx, t.id as string, b.body, b.internal);
    if (!b.internal && t.contact_email) await sendMail(req.ctx.db, req.ctx.ws, { to: t.contact_email as string, subject: `[#${t.number}] ${t.subject}`, html: b.body.replace(/\n/g, "<br/>"), contactId: t.contact_id as string | null, userId: req.ctx.user.id, activityId: a.id as string, fromName: req.ctx.user.name, track: false });
    return a;
  }));
  r.delete("/:id", h(async (req) => { deleteTicket(req.ctx, param(req, "id")); return { ok: true }; }));
  return r;
}
