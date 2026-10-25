/** Operaciones genéricas sobre registros de cualquier tablero (lectura, escritura de celdas, borrado). */
import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { updateContact, getContact, deleteContact } from "./contacts.js";
import { updateCompany, deleteCompany } from "./companies.js";
import { updateDeal, getDeal, deleteDeal } from "./deals.js";
import { updateTicket } from "./tickets.js";
import { updateTask, getTask } from "./tasks.js";
import { getContract, updateContract, deleteContract } from "./clm.js";

export const OBJECT_TABLE: Record<string, string> = { contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", task: "tasks", contract: "contracts", quote: "quotes" };
export const OBJECT_PATH: Record<string, string> = { contact: "/contactos", company: "/empresas", deal: "/negocios", ticket: "/tickets", task: "/tareas", contract: "/contratos" };
export const OBJECT_LABEL: Record<string, string> = { contact: "contacto", company: "empresa", deal: "negocio", ticket: "ticket", task: "tarea", contract: "contrato", quote: "presupuesto" };

export function loadRecord(ctx: Ctx, object: string, rid: string): Record<string, unknown> | null {
  try {
    if (object === "contact") { const c = getContact(ctx, rid); const company = c.company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.company_id), ["tags", "custom"]) : null; return { ...c, company }; }
    if (object === "deal") { const d = getDeal(ctx, rid); const company = d.company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", d.company_id), ["tags", "custom"]) : null; return { ...d, company }; }
    if (object === "company") return parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=? AND deleted_at IS NULL", rid), ["tags", "custom"]) ?? null;
    if (object === "ticket") return parseJson(ctx.db.get<Row>("SELECT * FROM tickets WHERE id=?", rid), ["tags"]) ?? null;
    if (object === "task") return getTask(ctx, rid);
    if (object === "contract") { const c = getContract(ctx, rid); const company = c.counterparty_company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", c.counterparty_company_id), ["tags", "custom"]) : null; return { ...c, company }; }
    if (object === "quote") return ctx.db.get<Row>("SELECT * FROM quotes WHERE id=?", rid) ?? null;
  } catch { return null; }
  return null;
}

/** Escribe un parche en un registro respetando la lógica de negocio del objeto (validaciones, eventos, auditoría). */
export function applyPatch(ctx: Ctx, object: string, rid: string, patch: Record<string, unknown>, depth = 0) {
  switch (object) {
    case "contact": return updateContact(ctx, rid, patch, { depth });
    case "company": return updateCompany(ctx, rid, patch, { depth });
    case "deal": return updateDeal(ctx, rid, patch, { depth });
    case "ticket": return updateTicket(ctx, rid, patch, { depth });
    case "task": return updateTask(ctx, rid, patch);
    case "contract": return updateContract(ctx, rid, patch as never);
    default: throw badRequest(`No se puede actualizar ${object}`);
  }
}
/** Convierte {"custom.x": v, campo: v} en un parche del servicio. */
export function cellsToPatch(values: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}; const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) { if (k.startsWith("custom.")) custom[k.slice(7)] = v; else patch[k] = v; }
  if (Object.keys(custom).length) patch.custom = custom;
  return patch;
}
export function archiveRecord(ctx: Ctx, object: string, rid: string) {
  switch (object) {
    case "contact": return deleteContact(ctx, rid);
    case "company": return deleteCompany(ctx, rid);
    case "deal": return deleteDeal(ctx, rid);
    case "contract": return deleteContract(ctx, rid);
    default: throw badRequest(`No se puede archivar ${object}`);
  }
}
export function recordName(object: string, r: Row): string {
  if (object === "contact") return `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
  return String(r.name ?? r.title ?? r.subject ?? r.number ?? r.id ?? "");
}
