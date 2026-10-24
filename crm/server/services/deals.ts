import { z } from "zod";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now, round2, daysBetween, monthKey } from "../lib/util.js";
import { badRequest, notFound, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord, ownerScope } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { tagsSchema, validateCustom, nullableStr, listRecords, type ListQuery, parseFilters } from "./records.js";
import { systemNote } from "./activities.js";
import { buildWhere } from "../lib/filters.js";
import { getContact } from "./contacts.js";

export const LOSS_REASONS = ["price", "competitor", "no_budget", "no_response", "timing", "no_need", "other"] as const;
export const LOSS_LABELS: Record<string, string> = { price: "Precio", competitor: "Competidor", no_budget: "Sin presupuesto", no_response: "Sin respuesta", timing: "Timing", no_need: "Sin necesidad", other: "Otro" };

export const dealSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(200),
  company_id: z.string().nullable().optional(),
  pipeline_id: z.string().optional(),
  stage_id: z.string().optional(),
  amount: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expected_close_date: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
  source: nullableStr,
  contact_ids: z.array(z.string()).optional(),
  contacts: z.array(z.object({ contact_id: z.string(), role: z.string().default("decision_maker") })).optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.unknown()).optional(),
});
export type DealInput = z.infer<typeof dealSchema>;

const JC = ["tags", "custom"];

export function getDeal(ctx: Ctx, did: string): Row {
  const d = parseJson(ctx.db.get<Row>(`SELECT d.*, co.name AS company_name, u.name AS owner_name, s.name AS stage_name, s.color AS stage_color, s.expected_days AS stage_expected_days, s.kind AS stage_kind, p.name AS pipeline_name
     FROM deals d LEFT JOIN companies co ON co.id=d.company_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN stages s ON s.id=d.stage_id LEFT JOIN pipelines p ON p.id=d.pipeline_id WHERE d.id=? AND d.workspace_id=?`, did, ctx.ws), JC);
  if (!d || d.deleted_at) throw notFound("Negocio");
  if (!canSeeRecord(ctx, d.owner_id as string | null)) throw forbidden("Este negocio pertenece a otro equipo");
  d.contacts = ctx.db.all<Row>("SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.job_title, dc.role FROM deal_contacts dc JOIN contacts c ON c.id=dc.contact_id WHERE dc.deal_id=? AND c.deleted_at IS NULL", did);
  d.products = ctx.db.all<Row>("SELECT * FROM deal_products WHERE deal_id=?", did);
  d.weighted_amount = round2(((d.amount as number) * (d.probability as number)) / 100);
  d.days_in_stage = Math.floor(daysBetween(d.stage_entered_at as string, now()));
  d.stage_history = ctx.db.all<Row>("SELECT h.*, s.name AS stage_name, u.name AS user_name FROM deal_stage_history h LEFT JOIN stages s ON s.id=h.to_stage_id LEFT JOIN users u ON u.id=h.user_id WHERE h.deal_id=? ORDER BY h.entered_at", did);
  return d;
}

export function listDeals(ctx: Ctx, q: ListQuery) {
  assert(ctx, "deal", "read");
  return listRecords<Row>(ctx, "deal", q, {
    select: "(SELECT name FROM companies WHERE id=t.company_id) AS company_name, (SELECT name FROM users WHERE id=t.owner_id) AS owner_name, (SELECT name FROM stages WHERE id=t.stage_id) AS stage_name, (SELECT color FROM stages WHERE id=t.stage_id) AS stage_color, (SELECT name FROM pipelines WHERE id=t.pipeline_id) AS pipeline_name, ROUND(t.amount*t.probability/100.0,2) AS weighted_amount",
  });
}

export function withRelated(ctx: Ctx, d: Row): Row {
  const company = d.company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", d.company_id), ["tags", "custom"]) : null;
  const stage = ctx.db.get<Row>("SELECT * FROM stages WHERE id=?", d.stage_id);
  return { ...d, company: company ?? null, stage: stage ?? null };
}

function defaultPipeline(ctx: Ctx): Row {
  const p = ctx.db.get<Row>("SELECT * FROM pipelines WHERE workspace_id=? ORDER BY is_default DESC, position LIMIT 1", ctx.ws);
  if (!p) throw badRequest("No hay ningún pipeline configurado. Créalo en Ajustes → Pipelines");
  return p;
}
function firstStage(ctx: Ctx, pipelineId: string): Row {
  const s = ctx.db.get<Row>("SELECT * FROM stages WHERE pipeline_id=? AND kind='open' ORDER BY position LIMIT 1", pipelineId);
  if (!s) throw badRequest("El pipeline no tiene etapas");
  return s;
}
export function getStage(ctx: Ctx, stageId: string): Row {
  const s = ctx.db.get<Row>("SELECT * FROM stages WHERE id=? AND workspace_id=?", stageId, ctx.ws);
  if (!s) throw notFound("Etapa");
  return parseJson(s, ["required_fields"]) as Row;
}

export function createDeal(ctx: Ctx, input: DealInput, opts: { depth?: number } = {}): Row {
  assert(ctx, "deal", "create");
  const pipeline = input.pipeline_id ? ctx.db.get<Row>("SELECT * FROM pipelines WHERE id=? AND workspace_id=?", input.pipeline_id, ctx.ws) : defaultPipeline(ctx);
  if (!pipeline) throw notFound("Pipeline");
  const stage = input.stage_id ? getStage(ctx, input.stage_id) : firstStage(ctx, pipeline.id as string);
  if (stage.pipeline_id !== pipeline.id) throw badRequest("La etapa no pertenece al pipeline");
  if (input.expected_close_date && input.expected_close_date < now().slice(0, 10)) throw badRequest("La fecha de cierre prevista no puede ser anterior a hoy");
  const custom = validateCustom(ctx, "deal", input.custom ?? {});
  const row = {
    id: id(), workspace_id: ctx.ws, name: input.name.trim(), company_id: input.company_id ?? null, pipeline_id: pipeline.id, stage_id: stage.id, amount: input.amount ?? 0, currency: input.currency ?? ctx.settings.currency,
    probability: input.probability ?? (stage.probability as number), expected_close_date: input.expected_close_date ?? null, status: stage.kind === "open" ? "open" : (stage.kind as string), owner_id: input.owner_id === undefined ? ctx.user.id : input.owner_id, source: input.source ?? null,
    stage_entered_at: now(), tags: input.tags ?? [], custom, created_by: ctx.user.id, created_at: now(), updated_at: now(),
  };
  ctx.db.transaction(() => {
    ctx.db.insert("deals", row);
    ctx.db.insert("deal_stage_history", { id: id(), workspace_id: ctx.ws, deal_id: row.id, from_stage_id: null, to_stage_id: stage.id, user_id: ctx.user.id, entered_at: now() });
    const contacts = input.contacts ?? (input.contact_ids ?? []).map((contact_id) => ({ contact_id, role: "decision_maker" }));
    for (const c of contacts) ctx.db.run("INSERT OR REPLACE INTO deal_contacts (deal_id, contact_id, role) VALUES (?,?,?)", row.id, c.contact_id, c.role);
    for (const c of contacts) ctx.db.run("UPDATE contacts SET lifecycle_stage='opportunity' WHERE id=? AND lifecycle_stage IN ('subscriber','lead','mql','sql')", c.contact_id);
  });
  audit(ctx, "deal", row.id, "create", { name: row.name, amount: row.amount });
  systemNote(ctx, `Negocio creado en ${stage.name}`, { deal_id: row.id, company_id: row.company_id });
  const d = getDeal(ctx, row.id);
  emit(ctx, { type: "deal.created", object: "deal", record: withRelated(ctx, d), depth: opts.depth });
  return d;
}

export function updateDeal(ctx: Ctx, did: string, patch: Partial<DealInput>, opts: { depth?: number } = {}): Row {
  assert(ctx, "deal", "update");
  const prev = getDeal(ctx, did);
  const data: Record<string, unknown> = { ...patch };
  delete data.contact_ids; delete data.contacts; delete data.stage_id; delete data.pipeline_id;
  if (patch.expected_close_date && prev.status === "open" && patch.expected_close_date < now().slice(0, 10)) throw badRequest("La fecha de cierre prevista no puede ser anterior a hoy");
  if (patch.custom) data.custom = validateCustom(ctx, "deal", patch.custom, prev.custom as Record<string, unknown>, true);
  if (patch.amount !== undefined && (prev.products as Row[]).length) throw badRequest("El importe se calcula a partir de las líneas de producto");
  const changes = diff(prev, data);
  ctx.db.transaction(() => {
    if (Object.keys(changes).length) ctx.db.update("deals", did, { ...data, updated_at: now() });
    if (patch.contacts || patch.contact_ids) {
      const contacts = patch.contacts ?? (patch.contact_ids ?? []).map((contact_id) => ({ contact_id, role: "decision_maker" }));
      ctx.db.run("DELETE FROM deal_contacts WHERE deal_id=?", did);
      for (const c of contacts) ctx.db.run("INSERT OR REPLACE INTO deal_contacts (deal_id, contact_id, role) VALUES (?,?,?)", did, c.contact_id, c.role);
      changes.contacts = [(prev.contacts as Row[]).map((c) => c.id), contacts.map((c) => c.contact_id)];
    }
  });
  if (patch.stage_id && patch.stage_id !== prev.stage_id) return moveStage(ctx, did, patch.stage_id, opts);
  if (!Object.keys(changes).length) return prev;
  audit(ctx, "deal", did, "update", changes);
  if (changes.owner_id) systemNote(ctx, "Propietario cambiado", { deal_id: did }, { from: changes.owner_id[0], to: changes.owner_id[1] });
  const d = getDeal(ctx, did);
  emit(ctx, { type: "deal.updated", object: "deal", record: withRelated(ctx, d), previous: prev, changes, depth: opts.depth });
  return d;
}

/** Validate stage rules (required fields) then move; records history + audit + event. */
export function moveStage(ctx: Ctx, did: string, stageId: string, opts: { depth?: number; skipValidation?: boolean } = {}): Row {
  assert(ctx, "deal", "update");
  const prev = getDeal(ctx, did);
  const stage = getStage(ctx, stageId);
  if (stage.pipeline_id !== prev.pipeline_id) throw badRequest("La etapa pertenece a otro pipeline");
  if (stage.kind === "won") return closeDeal(ctx, did, { status: "won" }, opts);
  if (stage.kind === "lost") throw badRequest("Para marcar como perdido indica el motivo (usa la acción Marcar perdido)");
  if (!opts.skipValidation) {
    const missing = ((stage.required_fields as string[]) ?? []).filter((f) => {
      if (f === "contacts") return !(prev.contacts as Row[]).length;
      if (f === "products") return !(prev.products as Row[]).length;
      if (f.startsWith("custom.")) { const v = (prev.custom as Record<string, unknown>)[f.slice(7)]; return v === null || v === undefined || v === ""; }
      const v = prev[f];
      return v === null || v === undefined || v === "" || v === 0;
    });
    if (missing.length) throw badRequest(`Para pasar a "${stage.name}" faltan: ${missing.map(labelField).join(", ")}`, { missing });
  }
  const t = now();
  ctx.db.transaction(() => {
    ctx.db.run("UPDATE deal_stage_history SET left_at=? WHERE deal_id=? AND left_at IS NULL", t, did);
    ctx.db.insert("deal_stage_history", { id: id(), workspace_id: ctx.ws, deal_id: did, from_stage_id: prev.stage_id, to_stage_id: stageId, user_id: ctx.user.id, entered_at: t });
    ctx.db.update("deals", did, { stage_id: stageId, stage_entered_at: t, probability: stage.probability, status: "open", closed_at: null, loss_reason: null, updated_at: t });
  });
  audit(ctx, "deal", did, "stage_change", { stage_id: [prev.stage_id, stageId], stage: [prev.stage_name, stage.name] });
  systemNote(ctx, `Etapa: ${prev.stage_name} → ${stage.name}`, { deal_id: did, company_id: prev.company_id as string | null });
  const d = getDeal(ctx, did);
  emit(ctx, { type: "deal.stage_changed", object: "deal", record: withRelated(ctx, d), previous: prev, changes: { stage_id: [prev.stage_id, stageId] }, depth: opts.depth });
  return d;
}
function labelField(f: string) {
  return ({ amount: "importe", expected_close_date: "fecha de cierre prevista", company_id: "empresa", contacts: "contacto decisor", products: "líneas de producto", owner_id: "propietario" } as Record<string, string>)[f] ?? f.replace("custom.", "");
}

export const closeSchema = z.object({
  status: z.enum(["won", "lost"]),
  loss_reason: z.string().optional(),
  competitor: nullableStr,
  note: nullableStr,
  closed_at: z.string().optional(),
});
export function closeDeal(ctx: Ctx, did: string, input: z.infer<typeof closeSchema>, opts: { depth?: number } = {}): Row {
  assert(ctx, "deal", "update");
  const prev = getDeal(ctx, did);
  if (input.status === "lost" && !input.loss_reason) throw badRequest("Indica el motivo de pérdida");
  const stage = ctx.db.get<Row>("SELECT * FROM stages WHERE pipeline_id=? AND kind=? LIMIT 1", prev.pipeline_id, input.status);
  const t = input.closed_at ?? now();
  ctx.db.transaction(() => {
    if (stage) {
      ctx.db.run("UPDATE deal_stage_history SET left_at=? WHERE deal_id=? AND left_at IS NULL", t, did);
      ctx.db.insert("deal_stage_history", { id: id(), workspace_id: ctx.ws, deal_id: did, from_stage_id: prev.stage_id, to_stage_id: stage.id, user_id: ctx.user.id, entered_at: t });
    }
    ctx.db.update("deals", did, { status: input.status, closed_at: t, stage_id: stage?.id ?? prev.stage_id, stage_entered_at: t, probability: input.status === "won" ? 100 : 0, loss_reason: input.status === "lost" ? input.loss_reason : null, competitor: input.competitor ?? null, updated_at: t });
    if (input.status === "won") {
      for (const c of prev.contacts as Row[]) ctx.db.run("UPDATE contacts SET lifecycle_stage='customer', updated_at=? WHERE id=?", t, c.id);
      if (prev.company_id) ctx.db.run("UPDATE companies SET type='customer', updated_at=? WHERE id=? AND type='prospect'", t, prev.company_id);
    }
  });
  audit(ctx, "deal", did, "update", { status: [prev.status, input.status], loss_reason: input.loss_reason ?? null });
  systemNote(ctx, input.status === "won" ? "Negocio ganado" : `Negocio perdido · ${LOSS_LABELS[input.loss_reason ?? ""] ?? input.loss_reason}${input.competitor ? ` · ${input.competitor}` : ""}`, { deal_id: did, company_id: prev.company_id as string | null }, { note: input.note ?? null });
  const d = getDeal(ctx, did);
  emit(ctx, { type: input.status === "won" ? "deal.won" : "deal.lost", object: "deal", record: withRelated(ctx, d), previous: prev, depth: opts.depth });
  return d;
}

export function reopenDeal(ctx: Ctx, did: string): Row {
  assert(ctx, "deal", "update");
  const prev = getDeal(ctx, did);
  if (prev.status === "open") return prev;
  const last = ctx.db.get<{ from_stage_id: string | null }>("SELECT from_stage_id FROM deal_stage_history WHERE deal_id=? ORDER BY entered_at DESC LIMIT 1", did);
  const stage = (last?.from_stage_id ? ctx.db.get<Row>("SELECT * FROM stages WHERE id=? AND kind='open'", last.from_stage_id) : undefined) ?? firstStage(ctx, prev.pipeline_id as string);
  const t = now();
  ctx.db.transaction(() => {
    ctx.db.run("UPDATE deal_stage_history SET left_at=? WHERE deal_id=? AND left_at IS NULL", t, did);
    ctx.db.insert("deal_stage_history", { id: id(), workspace_id: ctx.ws, deal_id: did, from_stage_id: prev.stage_id, to_stage_id: stage.id, user_id: ctx.user.id, entered_at: t });
    ctx.db.update("deals", did, { status: "open", closed_at: null, loss_reason: null, competitor: null, stage_id: stage.id, stage_entered_at: t, probability: stage.probability, updated_at: t });
  });
  audit(ctx, "deal", did, "update", { status: [prev.status, "open"], reopened: true });
  systemNote(ctx, `Negocio reabierto en ${stage.name}`, { deal_id: did, company_id: prev.company_id as string | null });
  const d = getDeal(ctx, did);
  emit(ctx, { type: "deal.stage_changed", object: "deal", record: withRelated(ctx, d), previous: prev });
  return d;
}

export function deleteDeal(ctx: Ctx, did: string) {
  assert(ctx, "deal", "delete");
  const d = getDeal(ctx, did);
  ctx.db.update("deals", did, { deleted_at: now() });
  audit(ctx, "deal", did, "delete", { name: d.name });
  emit(ctx, { type: "deal.deleted", object: "deal", record: d });
}
export function restoreDeal(ctx: Ctx, did: string) {
  assert(ctx, "deal", "delete");
  ctx.db.run("UPDATE deals SET deleted_at=NULL WHERE id=? AND workspace_id=?", did, ctx.ws);
  audit(ctx, "deal", did, "restore");
}

export const lineSchema = z.object({ product_id: z.string().nullable().optional(), name: z.string().trim().min(1), quantity: z.number().min(0).default(1), unit_price: z.number().min(0).default(0), discount: z.number().min(0).max(100).default(0), billing_period: z.string().default("one_time") });
export function setDealProducts(ctx: Ctx, did: string, lines: z.infer<typeof lineSchema>[]): Row {
  assert(ctx, "deal", "update");
  const prev = getDeal(ctx, did);
  const total = round2(lines.reduce((s, l) => s + l.quantity * l.unit_price * (1 - l.discount / 100), 0));
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM deal_products WHERE deal_id=?", did);
    for (const l of lines) ctx.db.insert("deal_products", { id: id(), deal_id: did, product_id: l.product_id ?? null, name: l.name, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount, billing_period: l.billing_period, total: round2(l.quantity * l.unit_price * (1 - l.discount / 100)) });
    ctx.db.update("deals", did, { amount: lines.length ? total : prev.amount, updated_at: now() });
  });
  audit(ctx, "deal", did, "update", { amount: [prev.amount, total], products: [(prev.products as Row[]).length, lines.length] });
  const d = getDeal(ctx, did);
  emit(ctx, { type: "deal.updated", object: "deal", record: withRelated(ctx, d), previous: prev, changes: { amount: [prev.amount, total] } });
  return d;
}

/** Kanban board data: stages with deals, totals and activity traffic light. */
export function board(ctx: Ctx, pipelineId: string, q: { filters?: unknown; owner_id?: string; q?: string }) {
  assert(ctx, "deal", "read");
  const stages = ctx.db.all<Row>("SELECT * FROM stages WHERE pipeline_id=? AND workspace_id=? ORDER BY position", pipelineId, ctx.ws);
  const scope = ownerScope(ctx, "d.owner_id");
  const f = buildWhere("deal", parseFilters(q.filters), "d");
  const params: unknown[] = [ctx.ws, pipelineId, ...scope.params, ...f.params];
  let extra = "";
  if (q.owner_id) { extra += " AND d.owner_id=?"; params.push(q.owner_id); }
  if (q.q) { extra += " AND (d.name LIKE ? OR co.name LIKE ?)"; params.push(`%${q.q}%`, `%${q.q}%`); }
  const deals = ctx.db.all<Row>(
    `SELECT d.*, co.name AS company_name, u.name AS owner_name,
       (SELECT MIN(due_at) FROM tasks t WHERE t.deal_id=d.id AND t.completed_at IS NULL) AS next_task_at,
       (SELECT COUNT(*) FROM tasks t WHERE t.deal_id=d.id AND t.completed_at IS NULL AND t.due_at < ?) AS overdue_tasks
     FROM deals d LEFT JOIN companies co ON co.id=d.company_id LEFT JOIN users u ON u.id=d.owner_id
     WHERE d.workspace_id=? AND d.pipeline_id=? AND d.deleted_at IS NULL AND (d.status='open' OR d.closed_at >= date('now','-30 days')) AND ${scope.sql} AND ${f.sql}${extra}
     ORDER BY d.expected_close_date IS NULL, d.expected_close_date, d.updated_at DESC`,
    now(), ...params,
  );
  const t = now();
  const cols = stages.map((s) => {
    const items: Row[] = deals.filter((d) => d.stage_id === s.id).map((d): Row => {
      parseJson(d, JC);
      const days = Math.floor(daysBetween(d.stage_entered_at as string, t));
      const light = (d.overdue_tasks as number) > 0 ? "red" : d.next_task_at ? "green" : "yellow";
      return { ...d, days_in_stage: days, stale: d.status === "open" && days > (s.expected_days as number), light, weighted_amount: round2(((d.amount as number) * (d.probability as number)) / 100) };
    });
    return { ...s, deals: items, count: items.length, amount: round2(items.reduce((a, d) => a + (d.amount as number), 0)), weighted: round2(items.reduce((a, d) => a + (d.weighted_amount as number), 0)) };
  });
  return { pipeline_id: pipelineId, stages: cols };
}

/** Forecast: open deals grouped by expected close month with weighted sums. */
export function forecast(ctx: Ctx, pipelineId?: string) {
  assert(ctx, "deal", "read");
  const scope = ownerScope(ctx, "owner_id");
  const params: unknown[] = [ctx.ws, ...scope.params];
  let extra = "";
  if (pipelineId) { extra = " AND pipeline_id=?"; params.push(pipelineId); }
  const rows = ctx.db.all<Row>(`SELECT d.*, (SELECT name FROM companies WHERE id=d.company_id) company_name, (SELECT name FROM stages WHERE id=d.stage_id) stage_name FROM deals d WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND ${scope.sql}${extra} ORDER BY expected_close_date`, ...params);
  const months: Record<string, { month: string; count: number; amount: number; weighted: number; committed: number; best_case: number; deals: Row[] }> = {};
  for (const d of rows) {
    const m = d.expected_close_date ? monthKey(d.expected_close_date as string) : "sin fecha";
    const g = (months[m] ??= { month: m, count: 0, amount: 0, weighted: 0, committed: 0, best_case: 0, deals: [] });
    const w = round2(((d.amount as number) * (d.probability as number)) / 100);
    g.count++; g.amount = round2(g.amount + (d.amount as number)); g.weighted = round2(g.weighted + w);
    if ((d.probability as number) >= 70) g.committed = round2(g.committed + (d.amount as number));
    if ((d.probability as number) >= 30) g.best_case = round2(g.best_case + (d.amount as number));
    g.deals.push({ id: d.id, name: d.name, company_name: d.company_name, stage_name: d.stage_name, amount: d.amount, probability: d.probability, weighted: w, expected_close_date: d.expected_close_date, owner_id: d.owner_id });
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
}

/** Convert a lead contact into company + deal (3.5). */
export const convertSchema = z.object({
  company: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  deal: z.object({ name: z.string().min(1), pipeline_id: z.string().optional(), stage_id: z.string().optional(), amount: z.number().min(0).optional(), expected_close_date: z.string().nullable().optional() }).optional(),
});
export function convertContact(ctx: Ctx, contactId: string, input: z.infer<typeof convertSchema>) {
  const c = getContact(ctx, contactId);
  let companyId = (c.company_id as string | null) ?? null;
  ctx.db.transaction(() => {
    if (input.company?.id) companyId = input.company.id;
    else if (input.company?.name) {
      const existing = ctx.db.get<Row>("SELECT id FROM companies WHERE workspace_id=? AND lower(name)=lower(?) AND deleted_at IS NULL", ctx.ws, input.company.name);
      if (existing) companyId = existing.id as string;
      else {
        const cid = id();
        ctx.db.insert("companies", { id: cid, workspace_id: ctx.ws, name: input.company.name, domain: (c.email as string | null)?.split("@")[1] ?? null, owner_id: c.owner_id, type: "prospect", status: "active", tags: [], custom: {}, created_by: ctx.user.id, created_at: now(), updated_at: now() });
        companyId = cid;
      }
    }
    if (companyId !== c.company_id) ctx.db.update("contacts", contactId, { company_id: companyId, updated_at: now() });
    ctx.db.update("contacts", contactId, { lifecycle_stage: "opportunity", lead_status: "qualified", updated_at: now() });
  });
  let deal: Row | null = null;
  if (input.deal) deal = createDeal(ctx, { ...input.deal, company_id: companyId, owner_id: (c.owner_id as string | null) ?? ctx.user.id, contacts: [{ contact_id: contactId, role: "decision_maker" }], source: (c.source as string | null) ?? null });
  audit(ctx, "contact", contactId, "update", { converted: true, deal_id: deal?.id ?? null, company_id: companyId });
  systemNote(ctx, `Convertido en oportunidad${deal ? `: ${deal.name}` : ""}`, { contact_id: contactId, deal_id: (deal?.id as string | undefined) ?? null });
  return { contact: getContact(ctx, contactId), deal };
}
