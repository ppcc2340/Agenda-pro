import { z } from "zod";
import { applyDefaults, checkRequired } from "./columns.js";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now, normalizeEmail, normalizePhone, capitalizeName, domainFromEmail, FREE_EMAIL_DOMAINS } from "../lib/util.js";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { tagsSchema, validateCustom, nullableStr, listRecords, type ListQuery, JSON_COLS } from "./records.js";
import { findCompanyByDomain, createCompany } from "./companies.js";
import { systemNote } from "./activities.js";
import { recomputeScore } from "./scoring.js";

export const LIFECYCLE = ["subscriber", "lead", "mql", "sql", "opportunity", "customer", "evangelist", "lost"] as const;
export const LEAD_STATUS = ["new", "contacted", "qualified", "unqualified", "nurturing"] as const;
export const SOURCES = ["web", "referral", "event", "outbound", "ads", "import", "api", "other"] as const;

export const contactSchema = z.object({
  first_name: z.string().trim().min(1, "El nombre es obligatorio").max(100),
  last_name: z.string().trim().max(100).optional().default(""),
  email: z.string().trim().email("Email no válido").nullable().optional().or(z.literal("")),
  phone: nullableStr,
  job_title: nullableStr,
  company_id: z.string().nullable().optional(),
  company_name: z.string().trim().max(200).optional(), // convenience: create/link company by name
  lifecycle_stage: z.enum(LIFECYCLE).optional(),
  lead_status: z.enum(LEAD_STATUS).optional(),
  disqualify_reason: nullableStr,
  source: z.string().max(50).nullable().optional(),
  utm: z.record(z.string()).optional(),
  owner_id: z.string().nullable().optional(),
  language: nullableStr,
  timezone: nullableStr,
  address: nullableStr,
  city: nullableStr,
  country: nullableStr,
  linkedin: nullableStr,
  birthday: nullableStr,
  consent_marketing: z.boolean().optional(),
  consent_source: nullableStr,
  do_not_contact: z.boolean().optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.unknown()).optional(),
  qualification: z.record(z.unknown()).optional(),
});
export type ContactInput = z.infer<typeof contactSchema>;

const JC = JSON_COLS.contact ?? [];

export function getContact(ctx: Ctx, cid: string, opts: { allowDeleted?: boolean } = {}): Row {
  const c = parseJson(ctx.db.get<Row>("SELECT c.*, co.name AS company_name, co.domain AS company_domain, u.name AS owner_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.workspace_id=?", cid, ctx.ws), JC);
  if (!c || (c.deleted_at && !opts.allowDeleted)) throw notFound("Contacto");
  if (!canSeeRecord(ctx, c.owner_id as string | null)) throw forbidden("Este contacto pertenece a otro equipo");
  return c;
}

export function listContacts(ctx: Ctx, q: ListQuery) {
  assert(ctx, "contact", "read");
  return listRecords<Row>(ctx, "contact", q, {
    select: "(SELECT name FROM companies WHERE id=t.company_id) AS company_name, (SELECT name FROM users WHERE id=t.owner_id) AS owner_name, (SELECT COUNT(*) FROM deals d JOIN deal_contacts dc ON dc.deal_id=d.id WHERE dc.contact_id=t.id AND d.deleted_at IS NULL AND d.status='open') AS open_deals",
  });
}

export interface DupCandidate { id: string; name: string; email: string | null; phone: string | null; reason: string }
export function findDuplicateCandidates(ctx: Ctx, data: { email?: string | null; phone?: string | null; first_name?: string; last_name?: string; company_id?: string | null }, excludeId?: string): DupCandidate[] {
  const out: DupCandidate[] = [];
  const push = (rows: Row[], reason: string) => {
    for (const r of rows) if (r.id !== excludeId && !out.some((o) => o.id === r.id)) out.push({ id: r.id as string, name: `${r.first_name} ${r.last_name}`.trim(), email: r.email as string | null, phone: r.phone as string | null, reason });
  };
  if (data.email) push(ctx.db.all<Row>("SELECT * FROM contacts WHERE workspace_id=? AND email=? AND deleted_at IS NULL", ctx.ws, data.email), "mismo email");
  if (data.phone) push(ctx.db.all<Row>("SELECT * FROM contacts WHERE workspace_id=? AND phone=? AND deleted_at IS NULL", ctx.ws, data.phone), "mismo teléfono");
  if (data.first_name && data.last_name && data.company_id) push(ctx.db.all<Row>("SELECT * FROM contacts WHERE workspace_id=? AND lower(first_name)=lower(?) AND lower(last_name)=lower(?) AND company_id=? AND deleted_at IS NULL", ctx.ws, data.first_name, data.last_name, data.company_id), "mismo nombre y empresa");
  return out;
}

function normalize(input: Partial<ContactInput>, ctx: Ctx) {
  const out: Record<string, unknown> = { ...input };
  delete out.company_name;
  if (input.email !== undefined) out.email = normalizeEmail(input.email);
  if (input.phone !== undefined) out.phone = normalizePhone(input.phone, ctx.settings.default_country_code);
  if (input.first_name !== undefined) out.first_name = capitalizeName(input.first_name);
  if (input.last_name !== undefined) out.last_name = capitalizeName(input.last_name);
  if (input.consent_marketing !== undefined) out.consent_marketing = input.consent_marketing ? 1 : 0;
  if (input.do_not_contact !== undefined) out.do_not_contact = input.do_not_contact ? 1 : 0;
  return out;
}

/** Resolve company: explicit id, by name (create if missing), or auto-link by email domain. */
function resolveCompany(ctx: Ctx, input: Partial<ContactInput>, email: string | null, autoCreate: boolean): string | null {
  if (input.company_id) return input.company_id;
  if (input.company_name) {
    const existing = ctx.db.get<Row>("SELECT id FROM companies WHERE workspace_id=? AND lower(name)=lower(?) AND deleted_at IS NULL", ctx.ws, input.company_name);
    if (existing) return existing.id as string;
    const domain = domainFromEmail(email);
    const c = createCompany(ctx, { name: input.company_name, domain: domain && !FREE_EMAIL_DOMAINS.has(domain) ? domain : null, owner_id: input.owner_id ?? ctx.user.id }, { force: true, skipEvents: true });
    return c.id as string;
  }
  const domain = domainFromEmail(email);
  if (domain && !FREE_EMAIL_DOMAINS.has(domain) && !ctx.settings.internal_domains.includes(domain)) {
    const byDomain = findCompanyByDomain(ctx, domain);
    if (byDomain) return byDomain.id as string;
    if (autoCreate) {
      const name = domain.split(".")[0] ?? domain;
      return createCompany(ctx, { name: name.charAt(0).toUpperCase() + name.slice(1), domain, owner_id: input.owner_id ?? ctx.user.id }, { force: true, skipEvents: true }).id as string;
    }
  }
  return null;
}

export function createContact(ctx: Ctx, input: ContactInput, opts: { force?: boolean; autoCreateCompany?: boolean; source?: string; depth?: number } = {}): Row {
  assert(ctx, "contact", "create");
  input = applyDefaults(ctx, "contact", input);
  const data = normalize(input, ctx);
  const email = (data.email as string | null) ?? null;
  if (email && ctx.settings.internal_domains.includes(domainFromEmail(email) ?? "")) throw badRequest("Ese email pertenece a un dominio interno de tu empresa; no se crean contactos de compañeros");
  if (!opts.force) {
    const dups = findDuplicateCandidates(ctx, { email, phone: data.phone as string | null, first_name: data.first_name as string, last_name: data.last_name as string, company_id: input.company_id });
    if (dups.length) throw conflict("Puede que este contacto ya exista", { duplicates: dups });
  }
  const custom = validateCustom(ctx, "contact", input.custom ?? {});
  const company_id = resolveCompany(ctx, input, email, opts.autoCreateCompany ?? false);
  const row = {
    id: id(), workspace_id: ctx.ws, first_name: data.first_name, last_name: data.last_name ?? "", email, phone: data.phone ?? null, job_title: data.job_title ?? null, company_id,
    lifecycle_stage: input.lifecycle_stage ?? "lead", lead_status: input.lead_status ?? "new", disqualify_reason: null, source: input.source ?? opts.source ?? "other", utm: input.utm ?? {},
    owner_id: input.owner_id === undefined ? ctx.user.id : input.owner_id, score: 0, language: data.language ?? null, timezone: data.timezone ?? null, address: data.address ?? null, city: data.city ?? null, country: data.country ?? null, linkedin: data.linkedin ?? null, birthday: data.birthday ?? null,
    consent_marketing: data.consent_marketing ?? 0, consent_date: input.consent_marketing ? now() : null, consent_source: data.consent_source ?? null, do_not_contact: data.do_not_contact ?? 0,
    tags: input.tags ?? [], custom, qualification: input.qualification ?? {}, created_by: ctx.user.id, created_at: now(), updated_at: now(),
  };
  ctx.db.insert("contacts", row);
  recomputeScore(ctx, row.id);
  audit(ctx, "contact", row.id, "create", { name: `${row.first_name} ${row.last_name}`.trim(), email });
  const c = getContact(ctx, row.id);
  emit(ctx, { type: "contact.created", object: "contact", record: withRelated(ctx, c), depth: opts.depth });
  return c;
}

export function withRelated(ctx: Ctx, c: Row): Row {
  const company = c.company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.company_id), ["tags", "custom"]) : null;
  return { ...c, company: company ?? null };
}

export function updateContact(ctx: Ctx, cid: string, patch: Partial<ContactInput>, opts: { depth?: number; actor?: string } = {}): Row {
  assert(ctx, "contact", "update");
  const prev = getContact(ctx, cid);
  const data = normalize(patch, ctx);
  if (patch.company_name && !patch.company_id) data.company_id = resolveCompany(ctx, patch, (data.email as string | null) ?? (prev.email as string | null), true);
  if (patch.custom) data.custom = validateCustom(ctx, "contact", patch.custom, prev.custom as Record<string, unknown>, true);
  checkRequired(ctx, "contact", prev, data);
  if (patch.consent_marketing !== undefined && !!patch.consent_marketing !== !!prev.consent_marketing) data.consent_date = now();
  if (data.email && data.email !== prev.email) {
    const dup = ctx.db.get<Row>("SELECT id FROM contacts WHERE workspace_id=? AND email=? AND id!=? AND deleted_at IS NULL", ctx.ws, data.email, cid);
    if (dup) throw conflict("Ya existe otro contacto con ese email", { duplicates: [{ id: dup.id }] });
  }
  if (patch.lead_status === "unqualified" && !patch.disqualify_reason && !prev.disqualify_reason) throw badRequest("Indica el motivo de descalificación");
  const changes = diff(prev, data);
  if (!Object.keys(changes).length) return prev;
  ctx.db.update("contacts", cid, { ...data, updated_at: now() });
  recomputeScore(ctx, cid);
  audit(ctx, "contact", cid, "update", changes);
  if (changes.lifecycle_stage) systemNote(ctx, `Etapa del ciclo de vida: ${labelLifecycle(String(changes.lifecycle_stage[0]))} → ${labelLifecycle(String(changes.lifecycle_stage[1]))}`, { contact_id: cid });
  if (changes.owner_id) systemNote(ctx, `Propietario cambiado`, { contact_id: cid }, { from: changes.owner_id[0], to: changes.owner_id[1] });
  const c = getContact(ctx, cid);
  emit(ctx, { type: "contact.updated", object: "contact", record: withRelated(ctx, c), previous: prev, changes, depth: opts.depth });
  return c;
}

export function labelLifecycle(s: string) {
  return ({ subscriber: "Suscriptor", lead: "Lead", mql: "MQL", sql: "SQL", opportunity: "Oportunidad", customer: "Cliente", evangelist: "Evangelista", lost: "Perdido" } as Record<string, string>)[s] ?? s;
}

export function deleteContact(ctx: Ctx, cid: string) {
  assert(ctx, "contact", "delete");
  const c = getContact(ctx, cid);
  ctx.db.update("contacts", cid, { deleted_at: now() });
  audit(ctx, "contact", cid, "delete", { name: `${c.first_name} ${c.last_name}` });
  emit(ctx, { type: "contact.deleted", object: "contact", record: c });
}
export function restoreContact(ctx: Ctx, cid: string) {
  assert(ctx, "contact", "delete");
  ctx.db.run("UPDATE contacts SET deleted_at=NULL, merged_into=NULL WHERE id=? AND workspace_id=?", cid, ctx.ws);
  audit(ctx, "contact", cid, "restore");
}

/** Merge `mergedId` into `survivorId`. `choices` picks per-field source ('a' survivor, 'b' merged). Reversible 30 days through merges snapshot. */
export function mergeContacts(ctx: Ctx, survivorId: string, mergedId: string, choices: Record<string, "a" | "b"> = {}) {
  assert(ctx, "contact", "update");
  if (survivorId === mergedId) throw badRequest("Elige dos contactos distintos");
  const a = getContact(ctx, survivorId);
  const b = getContact(ctx, mergedId);
  const mergeable = ["first_name", "last_name", "email", "phone", "job_title", "company_id", "lifecycle_stage", "lead_status", "source", "owner_id", "language", "timezone", "address", "city", "country", "linkedin", "birthday"];
  const patch: Record<string, unknown> = {};
  for (const f of mergeable) {
    const pick = choices[f] ?? (a[f] === null || a[f] === "" ? "b" : "a");
    const v = pick === "b" ? b[f] : a[f];
    if (v !== a[f]) patch[f] = v;
  }
  const tags = Array.from(new Set([...(a.tags as string[]), ...(b.tags as string[])]));
  patch.tags = tags;
  patch.custom = { ...(b.custom as Record<string, unknown>), ...(a.custom as Record<string, unknown>) };
  patch.score = Math.max(a.score as number, b.score as number);
  patch.consent_marketing = (a.consent_marketing as number) || (b.consent_marketing as number) ? 1 : 0;
  ctx.db.transaction(() => {
    ctx.db.insert("merges", { id: id(), workspace_id: ctx.ws, object: "contact", survivor_id: survivorId, merged_id: mergedId, snapshot: { survivor: a, merged: b }, user_id: ctx.user.id, created_at: now() });
    ctx.db.run("UPDATE activities SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("UPDATE tasks SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("UPDATE tickets SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("UPDATE emails SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("UPDATE form_submissions SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("UPDATE OR IGNORE deal_contacts SET contact_id=? WHERE contact_id=?", survivorId, mergedId);
    ctx.db.run("DELETE FROM deal_contacts WHERE contact_id=?", mergedId);
    ctx.db.run("UPDATE OR IGNORE list_members SET record_id=? WHERE record_id=?", survivorId, mergedId);
    ctx.db.run("DELETE FROM list_members WHERE record_id=?", mergedId);
    ctx.db.update("contacts", mergedId, { deleted_at: now(), merged_into: survivorId, email: null, phone: null });
    ctx.db.update("contacts", survivorId, { ...patch, updated_at: now() });
  });
  audit(ctx, "contact", survivorId, "merge", { merged: mergedId, fields: patch });
  systemNote(ctx, `Fusionado con ${b.first_name} ${b.last_name}`, { contact_id: survivorId }, { merged_id: mergedId });
  return getContact(ctx, survivorId);
}

export function undoMerge(ctx: Ctx, mergeId: string) {
  assert(ctx, "contact", "update");
  const m = parseJson(ctx.db.get<Row>("SELECT * FROM merges WHERE id=? AND workspace_id=?", mergeId, ctx.ws), ["snapshot"]);
  if (!m) throw notFound("Fusión");
  const snap = m.snapshot as { survivor: Row; merged: Row };
  const restore = (r: Row) => {
    const { company_name, company_domain, owner_name, ...cols } = r; void company_name; void company_domain; void owner_name;
    ctx.db.update("contacts", r.id as string, { ...cols, deleted_at: null, merged_into: null });
  };
  ctx.db.transaction(() => { restore(snap.survivor); restore(snap.merged); ctx.db.run("DELETE FROM merges WHERE id=?", mergeId); });
  audit(ctx, "contact", m.survivor_id as string, "update", { undo_merge: m.merged_id });
}

/** Group probable duplicates by email, phone or name+company. */
export function duplicateGroups(ctx: Ctx) {
  assert(ctx, "contact", "read");
  const groups: { key: string; reason: string; contacts: Row[] }[] = [];
  const byEmail = ctx.db.all<{ email: string; n: number }>("SELECT email, COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND email IS NOT NULL GROUP BY email HAVING n>1 LIMIT 100", ctx.ws);
  for (const g of byEmail) groups.push({ key: g.email, reason: "mismo email", contacts: ctx.db.all<Row>("SELECT id, first_name, last_name, email, phone, company_id, updated_at FROM contacts WHERE workspace_id=? AND email=? AND deleted_at IS NULL", ctx.ws, g.email) });
  const byPhone = ctx.db.all<{ phone: string; n: number }>("SELECT phone, COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND phone IS NOT NULL GROUP BY phone HAVING n>1 LIMIT 100", ctx.ws);
  for (const g of byPhone) groups.push({ key: g.phone, reason: "mismo teléfono", contacts: ctx.db.all<Row>("SELECT id, first_name, last_name, email, phone, company_id, updated_at FROM contacts WHERE workspace_id=? AND phone=? AND deleted_at IS NULL", ctx.ws, g.phone) });
  const byName = ctx.db.all<{ k: string; n: number }>("SELECT lower(first_name)||'|'||lower(last_name)||'|'||COALESCE(company_id,'') k, COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND company_id IS NOT NULL GROUP BY k HAVING n>1 LIMIT 100", ctx.ws);
  for (const g of byName) {
    const [fn, ln, co] = g.k.split("|");
    groups.push({ key: g.k, reason: "mismo nombre y empresa", contacts: ctx.db.all<Row>("SELECT id, first_name, last_name, email, phone, company_id, updated_at FROM contacts WHERE workspace_id=? AND lower(first_name)=? AND lower(last_name)=? AND company_id=? AND deleted_at IS NULL", ctx.ws, fn, ln, co) });
  }
  return groups;
}

/** GDPR: export everything known about a person. */
export function exportContactData(ctx: Ctx, cid: string) {
  assert(ctx, "contact", "export");
  const c = getContact(ctx, cid);
  const activities = ctx.db.all<Row>("SELECT * FROM activities WHERE contact_id=? ORDER BY occurred_at", cid);
  const tasks = ctx.db.all<Row>("SELECT * FROM tasks WHERE contact_id=?", cid);
  const deals = ctx.db.all<Row>("SELECT d.*, dc.role FROM deals d JOIN deal_contacts dc ON dc.deal_id=d.id WHERE dc.contact_id=?", cid);
  const tickets = ctx.db.all<Row>("SELECT * FROM tickets WHERE contact_id=?", cid);
  const emails = ctx.db.all<Row>("SELECT id, to_email, subject, status, opens, clicks, sent_at FROM emails WHERE contact_id=?", cid);
  const submissions = ctx.db.all<Row>("SELECT * FROM form_submissions WHERE contact_id=?", cid);
  ctx.db.insert("gdpr_requests", { id: id(), workspace_id: ctx.ws, contact_id: cid, type: "export", user_id: ctx.user.id, created_at: now() });
  audit(ctx, "contact", cid, "export", { gdpr: true });
  return { contact: c, activities, tasks, deals, tickets, emails, form_submissions: submissions, exported_at: now() };
}

/** GDPR: remove personal data, keep statistics (deals, counts). */
export function anonymizeContact(ctx: Ctx, cid: string) {
  assert(ctx, "contact", "delete");
  getContact(ctx, cid);
  ctx.db.transaction(() => {
    ctx.db.update("contacts", cid, { first_name: "Anonimizado", last_name: "", email: null, phone: null, job_title: null, address: null, city: null, linkedin: null, birthday: null, utm: {}, custom: {}, qualification: {}, tags: [], consent_marketing: 0, do_not_contact: 1, anonymized_at: now(), updated_at: now() });
    ctx.db.run("UPDATE activities SET body=NULL, subject='[anonimizado]' WHERE contact_id=? AND type!='system'", cid);
    ctx.db.run("UPDATE emails SET body='', to_email='anonimizado@example.invalid', subject='[anonimizado]' WHERE contact_id=?", cid);
    ctx.db.run("UPDATE form_submissions SET data='{}' WHERE contact_id=?", cid);
    ctx.db.run("UPDATE tasks SET description=NULL WHERE contact_id=?", cid);
    ctx.db.insert("gdpr_requests", { id: id(), workspace_id: ctx.ws, contact_id: cid, type: "anonymize", user_id: ctx.user.id, created_at: now() });
  });
  audit(ctx, "contact", cid, "anonymize");
  return getContact(ctx, cid);
}
