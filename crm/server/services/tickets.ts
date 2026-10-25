import { z } from "zod";
import { applyDefaults, checkRequired } from "./columns.js";
import type { Ctx } from "../context.js";
import type { Row } from "../db.js";
import { id, now } from "../lib/util.js";
import { notFound, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { notify } from "./notifications.js";
import { nullableStr, tagsSchema, listRecords, type ListQuery } from "./records.js";
import { logActivity } from "./activities.js";
import { nextCounter } from "./counters.js";

export const TICKET_STATUS = ["new", "open", "pending", "resolved", "closed"] as const;
export const ticketSchema = z.object({
  subject: z.string().trim().min(1, "El asunto es obligatorio").max(300),
  description: nullableStr,
  contact_id: z.string().nullable().optional(),
  company_id: z.string().nullable().optional(),
  deal_id: z.string().nullable().optional(),
  channel: z.string().optional(),
  status: z.enum(TICKET_STATUS).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  category: nullableStr,
  assignee_id: z.string().nullable().optional(),
  tags: tagsSchema.optional(),
  csat: z.number().int().min(1).max(5).nullable().optional(),
});
export type TicketInput = z.infer<typeof ticketSchema>;

const SELECT = `t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name, (SELECT first_name||' '||last_name FROM contacts WHERE id=t.contact_id) contact_name, (SELECT email FROM contacts WHERE id=t.contact_id) contact_email, (SELECT name FROM companies WHERE id=t.company_id) company_name`;

export function getTicket(ctx: Ctx, tid: string): Row {
  const t = ctx.db.get<Row>(`SELECT ${SELECT} FROM tickets t WHERE t.id=? AND t.workspace_id=?`, tid, ctx.ws);
  if (!t) throw notFound("Ticket");
  if (!canSeeRecord(ctx, t.assignee_id as string | null)) throw forbidden("Este ticket es de otro equipo");
  try { t.tags = JSON.parse(t.tags as string); } catch { t.tags = []; }
  return t;
}
export function listTickets(ctx: Ctx, q: ListQuery) {
  assert(ctx, "ticket", "read");
  return listRecords<Row>(ctx, "ticket", q, { select: "(SELECT name FROM users WHERE id=t.assignee_id) assignee_name, (SELECT first_name||' '||last_name FROM contacts WHERE id=t.contact_id) contact_name, (SELECT name FROM companies WHERE id=t.company_id) company_name" });
}

function slaDue(ctx: Ctx, priority: string, from = now()) {
  const hours = ctx.settings.ticket_sla_hours[priority] ?? 24;
  return new Date(new Date(from).getTime() + hours * 3600000).toISOString();
}

export function createTicket(ctx: Ctx, input: TicketInput, opts: { depth?: number } = {}): Row {
  assert(ctx, "ticket", "create");
  input = applyDefaults(ctx, "ticket", input);
  const priority = input.priority ?? "normal";
  const row = { id: id(), workspace_id: ctx.ws, number: nextCounter(ctx.db, ctx.ws, "ticket"), subject: input.subject, description: input.description ?? null, contact_id: input.contact_id ?? null, company_id: input.company_id ?? null, deal_id: input.deal_id ?? null, channel: input.channel ?? "manual", status: input.status ?? "new", priority, category: input.category ?? null, assignee_id: input.assignee_id === undefined ? ctx.user.id : input.assignee_id, sla_due_at: slaDue(ctx, priority), tags: input.tags ?? [], created_by: ctx.user.id, created_at: now(), updated_at: now() };
  if (!row.company_id && row.contact_id) row.company_id = ctx.db.get<{ company_id: string | null }>("SELECT company_id FROM contacts WHERE id=?", row.contact_id)?.company_id ?? null;
  ctx.db.insert("tickets", row);
  audit(ctx, "ticket", row.id, "create", { subject: row.subject });
  if (row.assignee_id && row.assignee_id !== ctx.user.id) notify(ctx.db, ctx.ws, row.assignee_id, { type: "ticket_assigned", title: `Ticket #${row.number}: ${row.subject}`, link: `/tickets/${row.id}` });
  const t = getTicket(ctx, row.id);
  emit(ctx, { type: "ticket.created", object: "ticket", record: t, depth: opts.depth });
  return t;
}

export function updateTicket(ctx: Ctx, tid: string, patch: Partial<TicketInput>, opts: { depth?: number } = {}): Row {
  assert(ctx, "ticket", "update");
  const prev = getTicket(ctx, tid);
  const data: Record<string, unknown> = { ...patch };
  if (patch.priority && patch.priority !== prev.priority) data.sla_due_at = slaDue(ctx, patch.priority, prev.created_at as string);
  if (patch.status === "resolved" && prev.status !== "resolved") data.resolved_at = now();
  if (patch.status && patch.status !== "resolved" && patch.status !== "closed") data.resolved_at = null;
  checkRequired(ctx, "ticket", prev, data);
  const changes = diff(prev, data);
  if (!Object.keys(changes).length) return prev;
  ctx.db.update("tickets", tid, { ...data, updated_at: now() });
  audit(ctx, "ticket", tid, "update", changes);
  if (changes.status) logActivity(ctx, { type: "system", subject: `Estado del ticket: ${changes.status[0]} → ${changes.status[1]}`, ticket_id: tid, contact_id: prev.contact_id as string | null });
  if (changes.assignee_id && patch.assignee_id && patch.assignee_id !== ctx.user.id) notify(ctx.db, ctx.ws, patch.assignee_id, { type: "ticket_assigned", title: `Ticket #${prev.number} asignado: ${prev.subject}`, link: `/tickets/${tid}` });
  const t = getTicket(ctx, tid);
  emit(ctx, { type: changes.status?.[1] === "resolved" ? "ticket.resolved" : "ticket.updated", object: "ticket", record: t, previous: prev, changes, depth: opts.depth });
  return t;
}

export function deleteTicket(ctx: Ctx, tid: string) {
  assert(ctx, "ticket", "delete");
  const t = getTicket(ctx, tid);
  ctx.db.run("DELETE FROM tickets WHERE id=?", tid);
  audit(ctx, "ticket", tid, "delete", { subject: t.subject });
}

/** Reply to the ticket (email to contact if available) or internal note. */
export function replyTicket(ctx: Ctx, tid: string, body: string, internal: boolean) {
  const t = getTicket(ctx, tid);
  const a = logActivity(ctx, { type: internal ? "note" : "email", subject: internal ? "Nota interna" : `Re: ${t.subject}`, body, direction: internal ? null : "outbound", ticket_id: tid, contact_id: t.contact_id as string | null, company_id: t.company_id as string | null });
  if (!internal && t.status === "new") updateTicket(ctx, tid, { status: "open" });
  return a;
}
