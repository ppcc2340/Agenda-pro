import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now } from "../lib/util.js";
import { isoDate, nullableStr } from "./records.js";
import { badRequest } from "../lib/errors.js";

export const ACTIVITY_TYPES = ["email", "call", "meeting", "note", "task", "sms", "whatsapp", "chat", "system"] as const;

export const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().trim().max(300).default(""),
  body: nullableStr,
  occurred_at: isoDate.optional(),
  duration_min: z.number().int().min(0).nullable().optional(),
  outcome: nullableStr,
  direction: z.enum(["inbound", "outbound"]).nullable().optional(),
  contact_id: z.string().nullable().optional(),
  company_id: z.string().nullable().optional(),
  deal_id: z.string().nullable().optional(),
  ticket_id: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type ActivityInput = z.infer<typeof activitySchema>;

/** Log an activity and refresh last_activity_at on linked records. */
export function logActivity(ctx: Ctx, input: ActivityInput, userId: string | null = ctx.user.id): Row {
  if (!input.contact_id && !input.company_id && !input.deal_id && !input.ticket_id) throw badRequest("La actividad debe estar vinculada a un contacto, empresa, negocio o ticket");
  const at = input.occurred_at ?? now();
  const a = { id: id(), workspace_id: ctx.ws, type: input.type, subject: input.subject ?? "", body: input.body ?? null, occurred_at: at, duration_min: input.duration_min ?? null, outcome: input.outcome ?? null, direction: input.direction ?? null, user_id: userId, contact_id: input.contact_id ?? null, company_id: input.company_id ?? null, deal_id: input.deal_id ?? null, ticket_id: input.ticket_id ?? null, pinned: input.pinned ? 1 : 0, meta: input.meta ?? {}, created_at: now() };
  // Inherit company from contact / deal when missing so timelines stay complete.
  if (!a.company_id && a.contact_id) a.company_id = ctx.db.get<{ company_id: string | null }>("SELECT company_id FROM contacts WHERE id=?", a.contact_id)?.company_id ?? null;
  if (!a.company_id && a.deal_id) a.company_id = ctx.db.get<{ company_id: string | null }>("SELECT company_id FROM deals WHERE id=?", a.deal_id)?.company_id ?? null;
  ctx.db.insert("activities", a);
  if (input.type !== "system") {
    const touch = ["call", "email", "meeting", "sms", "whatsapp", "chat"].includes(input.type) && input.direction !== "inbound";
    if (a.contact_id) {
      ctx.db.run("UPDATE contacts SET last_activity_at=? WHERE id=? AND (last_activity_at IS NULL OR last_activity_at < ?)", at, a.contact_id, at);
      if (touch) ctx.db.run("UPDATE contacts SET last_contacted_at=?, first_response_at=COALESCE(first_response_at, ?) WHERE id=?", at, at, a.contact_id);
    }
    if (a.company_id) ctx.db.run("UPDATE companies SET last_activity_at=? WHERE id=? AND (last_activity_at IS NULL OR last_activity_at < ?)", at, a.company_id, at);
    if (a.deal_id) ctx.db.run("UPDATE deals SET last_activity_at=? WHERE id=? AND (last_activity_at IS NULL OR last_activity_at < ?)", at, a.deal_id, at);
    if (a.ticket_id && input.direction === "outbound") ctx.db.run("UPDATE tickets SET first_response_at=COALESCE(first_response_at, ?) WHERE id=?", at, a.ticket_id);
  }
  return parseJson(ctx.db.get<Row>("SELECT * FROM activities WHERE id=?", a.id), ["meta"]) as Row;
}

export function systemNote(ctx: Ctx, subject: string, links: { contact_id?: string | null; company_id?: string | null; deal_id?: string | null; ticket_id?: string | null }, meta: Record<string, unknown> = {}) {
  return logActivity(ctx, { type: "system", subject, ...links, meta });
}

/** Unified timeline for a record: activities + emails + pending tasks, newest first. */
export function timeline(ctx: Ctx, link: { contact_id?: string; company_id?: string; deal_id?: string; ticket_id?: string }, types?: string[]) {
  const col = link.contact_id ? "contact_id" : link.company_id ? "company_id" : link.deal_id ? "deal_id" : "ticket_id";
  const val = link.contact_id ?? link.company_id ?? link.deal_id ?? link.ticket_id;
  const typeFilter = types?.length ? ` AND a.type IN (${types.map(() => "?").join(",")})` : "";
  const items = ctx.db.all<Row>(
    `SELECT a.*, u.name AS user_name, e.opens AS email_opens, e.status AS email_status, e.first_opened_at AS email_first_opened_at
     FROM activities a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN emails e ON e.activity_id=a.id
     WHERE a.workspace_id=? AND a.${col}=?${typeFilter} ORDER BY a.pinned DESC, a.occurred_at DESC LIMIT 500`,
    ctx.ws, val, ...(types ?? []),
  );
  for (const it of items) parseJson(it, ["meta"]);
  return items;
}
