/** Diseño de fichas en el cliente: carga del diseño efectivo (por rol) y utilidades para formularios. */
import { useEffect, useState } from "react";
import { api } from "../api";
import { LIFECYCLE, LEAD_STATUS, SOURCES, COMPANY_TYPES, TASK_TYPES, PRIORITY, TICKET_STATUS, DEAL_STATUS, LOSS_REASONS } from "./format";
import { CSTATUS, RISK, RENEWAL, PAPER, URGENCY, PAYMENT_MODEL, KIND } from "./clm";

export interface LayoutField { key: string; required?: boolean; help?: string | null; default?: unknown; show_if?: { field: string; op?: "eq" | "ne" | "empty" | "not_empty"; value?: string | null } | null }
export interface LayoutSection { id: string; title: string; collapsed?: boolean; columns?: 1 | 2; fields: LayoutField[] }
export interface Layout { sections: LayoutSection[]; create: string[]; quick: string[]; include_new?: boolean }
export interface FieldInfo { key: string; label: string; type: string; builtin: boolean; options_ref?: string; locked?: boolean; access?: "edit" | "read" | "hidden" }
export interface EffectiveLayout { layout: Layout; source: "role" | "default" | "generated"; fields: FieldInfo[] }

const cache = new Map<string, Promise<EffectiveLayout>>();
export function loadLayout(object: string, fresh = false): Promise<EffectiveLayout> {
  if (fresh || !cache.has(object)) cache.set(object, api.get<EffectiveLayout>(`layouts/${object}`).catch((e) => { cache.delete(object); throw e; }));
  return cache.get(object)!;
}
export const invalidateLayouts = () => cache.clear();
/** Diseño efectivo del objeto para el rol del usuario (null mientras carga). */
export function useLayout(object: string): EffectiveLayout | null {
  const [l, setL] = useState<EffectiveLayout | null>(null);
  useEffect(() => { let on = true; loadLayout(object).then((x) => on && setL(x)).catch(() => undefined); const h = () => loadLayout(object, true).then((x) => on && setL(x)).catch(() => undefined); window.addEventListener("crm:layouts", h); return () => { on = false; window.removeEventListener("crm:layouts", h); }; }, [object]);
  return l;
}

const plain = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v]));
const fromStatus = (m: Record<string, { label: string }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.label]));
/** Opciones de los campos de estado nativos (por «objeto.campo»). */
export const BUILTIN_OPTIONS: Record<string, Record<string, string>> = {
  "contact.lifecycle_stage": plain(LIFECYCLE), "contact.lead_status": plain(LEAD_STATUS), "contact.source": plain(SOURCES), "deal.source": plain(SOURCES), "company.type": plain(COMPANY_TYPES),
  "task.type": plain(TASK_TYPES), "task.priority": { low: "Baja", normal: "Normal", high: "Alta" }, "ticket.priority": plain(PRIORITY), "ticket.status": plain(TICKET_STATUS), "deal.status": plain(DEAL_STATUS), "deal.loss_reason": plain(LOSS_REASONS),
  "contract.status": fromStatus(CSTATUS), "contract.risk_level": fromStatus(RISK), "contract.renewal_type": fromStatus(RENEWAL), "contract.paper_origin": fromStatus(PAPER), "contract.urgency": fromStatus(URGENCY), "contract.payment_model": fromStatus(PAYMENT_MODEL), "contract.kind": plain(KIND),
};

/** ¿Se cumple la condición de visibilidad del campo con los valores actuales? */
export function condHolds(c: LayoutField["show_if"], rec: Record<string, unknown>): boolean {
  if (!c) return true;
  const v = c.field.startsWith("custom.") ? ((rec.custom as Record<string, unknown> | undefined) ?? {})[c.field.slice(7)] : rec[c.field];
  const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  switch (c.op ?? "eq") { case "empty": return empty; case "not_empty": return !empty; case "ne": return String(v ?? "") !== String(c.value ?? ""); default: return String(v ?? "") === String(c.value ?? ""); }
}

/**
 * Ayuda para formularios de alta/edición: qué campos mostrar, cuáles van bloqueados, etiquetas con «*» y ayudas,
 * y valores por defecto, todo según el diseño del rol y la seguridad por campo.
 */
export function formLayout(eff: EffectiveLayout | null, access: (f: string) => "edit" | "read" | "hidden", opts: { edit: boolean; core?: string[] }) {
  const byKey = new Map<string, LayoutField>(); eff?.layout.sections.forEach((s) => s.fields.forEach((f) => byKey.set(f.key, f)));
  const create = new Set(eff?.layout.create ?? []);
  const core = new Set(opts.core ?? []);
  // con el diseño generado (nadie lo ha personalizado) el alta sigue mostrando todos los campos
  const all = opts.edit || !eff || eff.source === "generated";
  const isReq = (k: string) => core.has(k) || (!!byKey.get(k)?.required && (opts.edit || create.has(k)));
  const valueOf = (rec: Record<string, unknown>, k: string) => k.startsWith("custom.") ? ((rec.custom as Record<string, unknown> | undefined) ?? {})[k.slice(7)] : rec[k];
  const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  const L = {
    ready: !!eff,
    show: (k: string) => access(k) !== "hidden" && (all || core.has(k) || create.has(k)),
    ro: (k: string) => access(k) === "read",
    label: (k: string, text: string) => `${text.replace(/ \*$/, "")}${isReq(k) ? " *" : ""}`,
    hint: (k: string) => byKey.get(k)?.help ?? undefined,
    required: () => Array.from(byKey.values()).filter((f) => f.required && (opts.edit || create.has(f.key))).map((f) => f.key),
    defaults: (): Record<string, unknown> => Object.fromEntries(Array.from(byKey.values()).filter((f) => f.default !== undefined && f.default !== null && f.default !== "" && access(f.key) === "edit").map((f) => [f.key, f.default])),
    createKeys: () => eff?.layout.create ?? [],
    when: (k: string, rec: Record<string, unknown>) => condHolds(byKey.get(k)?.show_if ?? null, rec),
    /** Obligatorios del diseño que siguen vacíos (solo los visibles y editables). */
    missing: (rec: Record<string, unknown>) => L.required().filter((k) => L.show(k) && !L.ro(k) && L.when(k, rec) && empty(valueOf(rec, k))),
    /** Quita del envío lo que el rol no puede escribir (el servidor lo rechazaría con 403). */
    strip: <T extends Record<string, unknown>>(payload: T): T => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k === "custom" && v && typeof v === "object") { out.custom = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([ck]) => access(`custom.${ck}`) === "edit")); continue; }
        if (access(k) === "edit") out[k] = v;
      }
      return out as T;
    },
    /** Valores por defecto del diseño sobre un registro nuevo, sin pisar lo que la persona ya tocó. */
    withDefaults: (rec: Record<string, unknown>, touched: Set<string>) => {
      const d = Object.entries(L.defaults()).filter(([k]) => !touched.has(k)); if (!d.length) return rec;
      const out: Record<string, unknown> = { ...rec, custom: { ...((rec.custom as Record<string, unknown>) ?? {}) } };
      for (const [k, v] of d) { if (k.startsWith("custom.")) (out.custom as Record<string, unknown>)[k.slice(7)] = v; else out[k] = v; }
      return out;
    },
  };
  return L;
}
export type FormLayout = ReturnType<typeof formLayout>;
