import { z } from "zod";
import { applyDefaults, checkRequired } from "./columns.js";
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { id, now, normalizeDomain, normalizePhone, capitalizeName } from "../lib/util.js";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { tagsSchema, validateCustom, nullableStr, listRecords, type ListQuery } from "./records.js";

export const COMPANY_TYPES = ["prospect", "customer", "partner", "competitor", "supplier"] as const;

export const companySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(200),
  domain: nullableStr,
  sector: nullableStr,
  size: z.number().int().min(0).nullable().optional(),
  revenue: z.number().min(0).nullable().optional(),
  tax_id: nullableStr,
  address: nullableStr,
  city: nullableStr,
  country: nullableStr,
  phone: nullableStr,
  website: nullableStr,
  parent_id: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
  type: z.enum(COMPANY_TYPES).optional(),
  status: z.string().optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type CompanyInput = z.infer<typeof companySchema>;

const JSON_COLS = ["tags", "custom"];

export function getCompany(ctx: Ctx, cid: string): Row {
  const c = parseJson(ctx.db.get<Row>("SELECT c.*, u.name AS owner_name, p.name AS parent_name FROM companies c LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN companies p ON p.id=c.parent_id WHERE c.id=? AND c.workspace_id=?", cid, ctx.ws), JSON_COLS);
  if (!c || c.deleted_at) throw notFound("Empresa");
  if (!canSeeRecord(ctx, c.owner_id as string | null)) throw forbidden("Esta empresa pertenece a otro equipo");
  return c;
}

export function listCompanies(ctx: Ctx, q: ListQuery) {
  assert(ctx, "company", "read");
  return listRecords<Row>(ctx, "company", q, {
    select: "(SELECT name FROM users WHERE id=t.owner_id) AS owner_name, (SELECT COUNT(*) FROM contacts x WHERE x.company_id=t.id AND x.deleted_at IS NULL) AS contacts_count, (SELECT COUNT(*) FROM deals d WHERE d.company_id=t.id AND d.deleted_at IS NULL AND d.status='open') AS open_deals",
  });
}

export function findCompanyByDomain(ctx: Ctx, domain: string | null): Row | undefined {
  if (!domain) return undefined;
  return ctx.db.get<Row>("SELECT * FROM companies WHERE workspace_id=? AND domain=? AND deleted_at IS NULL", ctx.ws, domain);
}
export function findCompanyByName(ctx: Ctx, name: string): Row | undefined {
  return ctx.db.get<Row>("SELECT * FROM companies WHERE workspace_id=? AND lower(name)=lower(?) AND deleted_at IS NULL", ctx.ws, name.trim());
}

function normalize(input: Partial<CompanyInput>, ctx: Ctx) {
  const out: Record<string, unknown> = { ...input };
  if (input.domain !== undefined) out.domain = normalizeDomain(input.domain);
  if (input.website !== undefined && input.website && !out.domain) out.domain = normalizeDomain(input.website);
  if (input.phone !== undefined) out.phone = normalizePhone(input.phone, ctx.settings.default_country_code);
  if (input.name !== undefined) out.name = String(input.name).trim() === String(input.name).trim().toLowerCase() ? capitalizeName(input.name) : String(input.name).trim();
  return out;
}

export function createCompany(ctx: Ctx, input: CompanyInput, opts: { force?: boolean; skipEvents?: boolean } = {}): Row {
  assert(ctx, "company", "create");
  input = applyDefaults(ctx, "company", input);
  const data = normalize(input, ctx);
  if (!opts.force) {
    const dup = (data.domain ? findCompanyByDomain(ctx, data.domain as string) : undefined) ?? findCompanyByName(ctx, data.name as string);
    if (dup) throw conflict("Ya existe una empresa con ese nombre o dominio", { duplicate: { id: dup.id, name: dup.name, domain: dup.domain } });
  }
  const custom = validateCustom(ctx, "company", input.custom ?? {});
  const row = { id: id(), workspace_id: ctx.ws, name: data.name, domain: data.domain ?? null, sector: data.sector ?? null, size: data.size ?? null, revenue: data.revenue ?? null, tax_id: data.tax_id ?? null, address: data.address ?? null, city: data.city ?? null, country: data.country ?? null, phone: data.phone ?? null, website: data.website ?? null, parent_id: data.parent_id ?? null, owner_id: input.owner_id === undefined ? ctx.user.id : input.owner_id, type: input.type ?? "prospect", status: input.status ?? "active", tags: input.tags ?? [], custom, created_by: ctx.user.id, created_at: now(), updated_at: now() };
  ctx.db.insert("companies", row);
  audit(ctx, "company", row.id, "create", { name: row.name });
  const c = getCompany(ctx, row.id);
  if (!opts.skipEvents) emit(ctx, { type: "company.created", object: "company", record: c });
  return c;
}

export function updateCompany(ctx: Ctx, cid: string, patch: Partial<CompanyInput>, opts: { depth?: number } = {}): Row {
  assert(ctx, "company", "update");
  const prev = getCompany(ctx, cid);
  const data = normalize(patch, ctx);
  if (patch.parent_id && patch.parent_id === cid) throw badRequest("Una empresa no puede ser su propia matriz");
  if (patch.custom) data.custom = validateCustom(ctx, "company", patch.custom, prev.custom as Record<string, unknown>, true);
  checkRequired(ctx, "company", prev, data);
  const changes = diff(prev, data);
  if (!Object.keys(changes).length) return prev;
  ctx.db.update("companies", cid, { ...data, updated_at: now() });
  audit(ctx, "company", cid, "update", changes);
  const c = getCompany(ctx, cid);
  emit(ctx, { type: "company.updated", object: "company", record: c, previous: prev, changes, depth: opts.depth });
  return c;
}

export function deleteCompany(ctx: Ctx, cid: string) {
  assert(ctx, "company", "delete");
  const c = getCompany(ctx, cid);
  ctx.db.update("companies", cid, { deleted_at: now() });
  audit(ctx, "company", cid, "delete", { name: c.name });
  emit(ctx, { type: "company.deleted", object: "company", record: c });
}
export function restoreCompany(ctx: Ctx, cid: string) {
  assert(ctx, "company", "delete");
  ctx.db.run("UPDATE companies SET deleted_at=NULL WHERE id=? AND workspace_id=?", cid, ctx.ws);
  audit(ctx, "company", cid, "restore");
}

export function companyTree(ctx: Ctx, cid: string) {
  const root = getCompany(ctx, cid);
  let top = root;
  const seen = new Set<string>([cid]);
  while (top.parent_id && !seen.has(top.parent_id as string)) {
    seen.add(top.parent_id as string);
    const p = ctx.db.get<Row>("SELECT * FROM companies WHERE id=? AND deleted_at IS NULL", top.parent_id);
    if (!p) break;
    top = p;
  }
  const build = (node: Row): Row => {
    const children = ctx.db.all<Row>("SELECT * FROM companies WHERE parent_id=? AND deleted_at IS NULL", node.id).map(build);
    const deals = ctx.db.get<{ n: number; amount: number }>("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM deals WHERE company_id=? AND deleted_at IS NULL AND status='open'", node.id);
    return { id: node.id, name: node.name, type: node.type, open_deals: deals?.n ?? 0, open_amount: deals?.amount ?? 0, children };
  };
  return build(top);
}
