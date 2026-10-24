import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now, round2, token, addDays, renderTemplate } from "../lib/util.js";
import { badRequest, notFound } from "../lib/errors.js";
import { assert } from "../lib/permissions.js";
import { audit } from "./audit.js";
import { emit } from "./events.js";
import { nextCounter } from "./counters.js";
import { getDeal, moveStage } from "./deals.js";
import { systemNote } from "./activities.js";
import { sendMail } from "./email.js";
import { notify } from "./notifications.js";

export const productSchema = z.object({
  sku: z.string().trim().max(50).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  unit_price: z.number().min(0),
  currency: z.string().length(3).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  cost: z.number().min(0).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  unit: z.string().max(20).optional(),
  billing_period: z.enum(["one_time", "monthly", "yearly"]).optional(),
  active: z.boolean().optional(),
});

export const quoteLine = z.object({ product_id: z.string().nullable().optional(), name: z.string().min(1), description: z.string().nullable().optional(), quantity: z.number().min(0), unit_price: z.number().min(0), discount: z.number().min(0).max(100).default(0), tax_rate: z.number().min(0).max(100).default(21) });
export const quoteSchema = z.object({
  deal_id: z.string(),
  valid_days: z.number().int().min(1).max(365).default(30),
  lines: z.array(quoteLine).min(1, "Añade al menos una línea"),
  discount: z.number().min(0).max(100).default(0),
  notes: z.string().max(5000).nullable().optional(),
});

export function computeTotals(lines: z.infer<typeof quoteLine>[], globalDiscount: number) {
  let subtotal = 0, tax = 0;
  for (const l of lines) {
    const net = l.quantity * l.unit_price * (1 - l.discount / 100) * (1 - globalDiscount / 100);
    subtotal += net;
    tax += net * (l.tax_rate / 100);
  }
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax) };
}

export function getQuote(ctx: Ctx, qid: string): Row {
  const q = parseJson(ctx.db.get<Row>("SELECT q.*, d.name AS deal_name, d.company_id, (SELECT name FROM companies WHERE id=d.company_id) company_name, (SELECT name FROM users WHERE id=q.created_by) created_by_name FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.id=? AND q.workspace_id=?", qid, ctx.ws), ["lines"]);
  if (!q) throw notFound("Presupuesto");
  return q;
}

export function createQuote(ctx: Ctx, input: z.infer<typeof quoteSchema>): Row {
  assert(ctx, "quote", "create");
  const deal = getDeal(ctx, input.deal_id);
  const prevVersions = ctx.db.get<{ n: number; number: string | null }>("SELECT COUNT(*) n, MAX(number) number FROM quotes WHERE deal_id=?", input.deal_id);
  const number = prevVersions?.number ?? `${ctx.settings.quote_prefix}-${new Date().getFullYear()}-${String(nextCounter(ctx.db, ctx.ws, "quote")).padStart(4, "0")}`;
  const totals = computeTotals(input.lines, input.discount);
  const row = { id: id(), workspace_id: ctx.ws, deal_id: input.deal_id, number, version: (prevVersions?.n ?? 0) + 1, date: now().slice(0, 10), valid_until: addDays(now(), input.valid_days).slice(0, 10), lines: input.lines, subtotal: totals.subtotal, discount: input.discount, tax: totals.tax, total: totals.total, status: "draft", notes: input.notes ?? null, token: token(), views: 0, created_by: ctx.user.id, created_at: now() };
  ctx.db.insert("quotes", row);
  audit(ctx, "quote", row.id, "create", { number, total: totals.total, deal_id: deal.id });
  systemNote(ctx, `Presupuesto ${number} v${row.version} creado (${totals.total} ${deal.currency})`, { deal_id: deal.id as string, company_id: deal.company_id as string | null });
  return getQuote(ctx, row.id);
}

export async function sendQuote(ctx: Ctx, qid: string, to: string, message?: string | null) {
  assert(ctx, "quote", "update");
  const q = getQuote(ctx, qid);
  const base = process.env.PUBLIC_URL ?? "http://localhost:3000";
  const link = `${base}/q/${q.token}`;
  const html = `<p>${renderTemplate(message ?? "Hola,<br/>te enviamos el presupuesto {{number}}.", { number: q.number })}</p><p><a href="${link}">Ver presupuesto {{number}}</a></p><p>${ctx.user.name}<br/>${ctx.settings.company_name}</p>`.replace("{{number}}", q.number as string);
  const deal = getDeal(ctx, q.deal_id as string);
  const contact = (deal.contacts as Row[])[0];
  await sendMail(ctx.db, ctx.ws, { to, subject: `Presupuesto ${q.number} · ${ctx.settings.company_name}`, html, contactId: (contact?.id as string | undefined) ?? null, userId: ctx.user.id, fromName: ctx.user.name, track: false });
  ctx.db.update("quotes", qid, { status: q.status === "draft" ? "sent" : q.status, sent_at: now() });
  systemNote(ctx, `Presupuesto ${q.number} enviado a ${to}`, { deal_id: q.deal_id as string, contact_id: (contact?.id as string | undefined) ?? null });
  audit(ctx, "quote", qid, "update", { status: ["draft", "sent"], to });
  return { link };
}

export function updateQuoteStatus(ctx: Ctx, qid: string, status: string) {
  assert(ctx, "quote", "update");
  const q = getQuote(ctx, qid);
  if (!["draft", "sent", "viewed", "accepted", "rejected", "expired"].includes(status)) throw badRequest("Estado no válido");
  ctx.db.update("quotes", qid, { status, decided_at: ["accepted", "rejected"].includes(status) ? now() : null });
  audit(ctx, "quote", qid, "update", { status: [q.status, status] });
  if (status === "accepted") onAccepted(ctx, qid, "manual");
  return getQuote(ctx, qid);
}

/** Public view by token: marks as viewed, counts views, notifies owner (workflow trigger quote.viewed). */
export function publicView(ctx: Ctx, tok: string): Row | undefined {
  const q = parseJson(ctx.db.get<Row>("SELECT q.*, d.name AS deal_name, d.owner_id, d.currency, (SELECT name FROM companies WHERE id=d.company_id) company_name FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.token=?", tok), ["lines"]);
  if (!q) return undefined;
  const views = (q.views as number) + 1;
  ctx.db.update("quotes", q.id as string, { views, viewed_at: now(), status: q.status === "sent" ? "viewed" : q.status });
  if (q.valid_until && (q.valid_until as string) < now().slice(0, 10) && ["sent", "viewed"].includes(q.status as string)) ctx.db.update("quotes", q.id as string, { status: "expired" });
  notify(ctx.db, ctx.ws, q.owner_id as string | null, { type: "quote_viewed", title: `Presupuesto ${q.number} visto (${views} ${views === 1 ? "vez" : "veces"})`, link: `/negocios/${q.deal_id}` });
  systemNote(ctx, `Presupuesto ${q.number} visto por el cliente`, { deal_id: q.deal_id as string });
  emit(ctx, { type: "quote.viewed", object: "quote", record: { ...q, views } });
  return getQuote(ctx, q.id as string);
}

export function publicDecision(ctx: Ctx, tok: string, decision: "accepted" | "rejected", signer: { name: string; ip: string }) {
  const q = ctx.db.get<Row>("SELECT * FROM quotes WHERE token=?", tok);
  if (!q) throw notFound("Presupuesto");
  if (["accepted", "rejected"].includes(q.status as string)) throw badRequest("Este presupuesto ya tiene una decisión registrada");
  ctx.db.update("quotes", q.id as string, { status: decision, decided_at: now(), signer: JSON.stringify({ ...signer, at: now() }) });
  audit(ctx, "quote", q.id as string, "update", { status: [q.status, decision], signer: signer.name, ip: signer.ip });
  if (decision === "accepted") onAccepted(ctx, q.id as string, signer.name);
  else {
    const d = getDeal(ctx, q.deal_id as string);
    systemNote(ctx, `Presupuesto ${q.number} rechazado por ${signer.name}`, { deal_id: d.id as string });
    notify(ctx.db, ctx.ws, d.owner_id as string | null, { type: "quote_rejected", title: `Presupuesto ${q.number} rechazado`, link: `/negocios/${d.id}` });
    emit(ctx, { type: "quote.rejected", object: "quote", record: getQuote(ctx, q.id as string) });
  }
}

function onAccepted(ctx: Ctx, qid: string, by: string) {
  const q = getQuote(ctx, qid);
  const d = getDeal(ctx, q.deal_id as string);
  systemNote(ctx, `Presupuesto ${q.number} aceptado por ${by} (${q.total} ${d.currency})`, { deal_id: d.id as string });
  notify(ctx.db, ctx.ws, d.owner_id as string | null, { type: "quote_accepted", title: `Presupuesto ${q.number} aceptado`, body: `${d.name} · ${q.total} ${d.currency}`, link: `/negocios/${d.id}` });
  const target = ctx.settings.quote_accept_stage_id;
  if (target && d.status === "open" && d.stage_id !== target) {
    const st = ctx.db.get<Row>("SELECT * FROM stages WHERE id=? AND pipeline_id=?", target, d.pipeline_id);
    if (st) { try { moveStage(ctx, d.id as string, target, { skipValidation: true }); } catch (e) { console.warn("[quotes] no se pudo avanzar etapa", (e as Error).message); } }
  }
  emit(ctx, { type: "quote.accepted", object: "quote", record: q });
}
