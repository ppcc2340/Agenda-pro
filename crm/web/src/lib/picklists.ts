/**
 * Listas de valores del sistema (etiquetas editables con comportamiento). Se cargan una vez y se refrescan al
 * guardar; además actualizan en el sitio los diccionarios de etiquetas que usa el resto de la interfaz
 * (LIFECYCLE, TICKET_STATUS_OPTS, CSTATUS…), para que el vocabulario del usuario aparezca en todas partes.
 */
import { useSyncExternalStore } from "react";
import { api } from "../api";
import * as F from "./format";
import * as K from "./colors";
import * as L from "./clm";
import type { StatusOption } from "../components/DataTable";

export interface PicklistOption { id: string; label: string; color: string; role: string; position: number; hidden?: boolean }
export interface Picklist { key: string; module: "CRM" | "CLM"; object: string; field: string; label: string; extensible: boolean; roles: { key: string; label: string; color: string; logic?: string }[]; options: PicklistOption[]; usage: Record<string, number>; uncovered: { role: string; label: string; logic: string | null }[] }

let lists: Picklist[] = [];
let version = 0;
const subs = new Set<() => void>();
const notify = () => { version++; subs.forEach((f) => f()); };

/** Diccionarios heredados que se reescriben con la etiqueta principal de cada comportamiento. */
const LEGACY: Record<string, { labels?: Record<string, string>; opts?: Record<string, StatusOption> }[]> = {
  "contact.lifecycle_stage": [{ labels: F.LIFECYCLE, opts: K.LIFECYCLE_OPTS }],
  "contact.lead_status": [{ labels: F.LEAD_STATUS, opts: K.LEAD_STATUS_OPTS }],
  "company.type": [{ labels: F.COMPANY_TYPES, opts: K.COMPANY_TYPE_OPTS }],
  "deal.status": [{ labels: F.DEAL_STATUS, opts: K.DEAL_STATUS_OPTS }],
  "ticket.status": [{ labels: F.TICKET_STATUS, opts: K.TICKET_STATUS_OPTS }],
  "ticket.priority": [{ labels: F.PRIORITY, opts: K.PRIORITY_OPTS }],
  "task.type": [{ labels: F.TASK_TYPES }],
  "contract.status": [{ opts: L.CSTATUS }], "contract.risk_level": [{ opts: L.RISK }], "contract.urgency": [{ opts: L.URGENCY }], "contract.renewal_type": [{ opts: L.RENEWAL }],
  "contract.paper_origin": [{ opts: L.PAPER }], "contract.payment_model": [{ opts: L.PAYMENT_MODEL }], "obligation.type": [{ labels: L.OBL_TYPE }], "milestone.type": [{ labels: L.MS_TYPE }],
};
function applyLegacy(p: Picklist) {
  for (const t of LEGACY[p.key] ?? []) for (const r of p.roles) {
    const o = primaryOf(p, r.key); if (!o) continue;
    if (t.labels) t.labels[r.key] = o.label;
    if (t.opts) t.opts[r.key] = { ...(t.opts[r.key] ?? { color: o.color }), label: o.label, color: o.color };
  }
}
/** Etiqueta principal de un comportamiento: la de su mismo id, o la primera visible con ese comportamiento. */
export function primaryOf(p: Picklist, role: string): PicklistOption | undefined {
  return p.options.find((o) => o.id === role) ?? p.options.find((o) => o.role === role && !o.hidden) ?? p.options.find((o) => o.role === role);
}
/** Etiqueta que se muestra para un registro (role + id de etiqueta guardado en custom._lbl_<campo>). */
export function resolveOption(p: Picklist, role: unknown, lbl: unknown): PicklistOption | undefined {
  if (role === null || role === undefined || role === "") return undefined;
  if (lbl) { const o = p.options.find((x) => x.id === lbl && x.role === role); if (o) return o; }
  return primaryOf(p, String(role));
}

export async function loadPicklists(): Promise<void> {
  try { const r = await api.get<{ items: Picklist[] }>("picklists"); lists = r.items; lists.forEach(applyLegacy); notify(); } catch { /* sin permiso o sin sesión */ }
}
export const getPicklist = (key: string) => lists.find((p) => p.key === key);
export const picklistFor = (object: string, field: string) => lists.find((p) => p.object === object && p.field === field);
export function usePicklists(): Picklist[] {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  return lists;
}
export function usePicklist(key: string): Picklist | undefined { usePicklists(); return getPicklist(key); }
export async function savePicklist(key: string, options: Partial<PicklistOption>[], reassign: Record<string, string>): Promise<{ moved: number }> {
  const r = await api.put<Picklist & { moved: number }>(`picklists/${key}`, { options: options.map((o) => ({ id: o.id, label: o.label, color: o.color, role: o.role, hidden: !!o.hidden })), reassign });
  lists = lists.map((p) => (p.key === key ? r : p)); applyLegacy(r); notify();
  return { moved: r.moved };
}
/** Opciones para una columna de estado: clave = id de etiqueta; `base` indica el comportamiento cuando no es la principal. */
export function columnOptions(p: Picklist): Record<string, StatusOption> {
  return Object.fromEntries(p.options.map((o) => [o.id, { label: o.label, color: o.color, hidden: o.hidden, base: o.id === o.role ? undefined : o.role }]));
}
