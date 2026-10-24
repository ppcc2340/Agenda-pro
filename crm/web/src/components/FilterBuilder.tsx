import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../api";
import { OPS_LABEL, FIELD_LABEL, LIFECYCLE, LEAD_STATUS, SOURCES, COMPANY_TYPES, TICKET_STATUS, PRIORITY, DEAL_STATUS, LOSS_REASONS } from "../lib/format";
import { useApp, type CustomField } from "../lib/app";

export type Condition = { field: string; op: string; value?: unknown };
export type FilterGroup = { logic: "and" | "or"; conditions: Condition[] };
type Meta = { fields: Record<string, Record<string, string>>; ops: string[]; custom: Record<string, CustomField[]> };
let metaCache: Meta | null = null;

const NO_VALUE = new Set(["empty", "not_empty", "today", "is_true", "is_false"]);
const OPS_BY_KIND: Record<string, string[]> = {
  text: ["eq", "neq", "contains", "not_contains", "starts", "in", "not_in", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  date: ["last_days", "next_days", "today", "before", "after", "empty", "not_empty"],
  bool: ["is_true", "is_false"],
  json: ["contains", "not_contains", "empty", "not_empty"],
};
const ENUMS: Record<string, Record<string, string>> = { lifecycle_stage: LIFECYCLE, lead_status: LEAD_STATUS, source: SOURCES, type: COMPANY_TYPES, priority: PRIORITY, loss_reason: LOSS_REASONS };

export function FilterBuilder({ object, value, onChange }: { object: string; value: FilterGroup; onChange: (g: FilterGroup) => void }) {
  const [meta, setMeta] = useState<Meta | null>(metaCache);
  const { users, pipelines } = useApp();
  useEffect(() => { if (!meta) api.get<Meta>("filter-meta").then((m) => { metaCache = m; setMeta(m); }); }, [meta]);
  if (!meta) return null;
  const fields = meta.fields[object] ?? {};
  const custom = meta.custom[object] ?? [];
  const kindOf = (f: string) => { if (f.startsWith("custom.")) { const cf = custom.find((c) => c.key === f.slice(7)); return cf?.type === "number" || cf?.type === "currency" || cf?.type === "percent" ? "number" : cf?.type === "date" || cf?.type === "datetime" ? "date" : cf?.type === "boolean" ? "bool" : "text"; } return fields[f] ?? "text"; };
  const update = (i: number, patch: Partial<Condition>) => { const c = value.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)); onChange({ ...value, conditions: c }); };
  const enumFor = (f: string): Record<string, string> | null => {
    if (object === "deal" && f === "status") return DEAL_STATUS;
    if (object === "ticket" && f === "status") return TICKET_STATUS;
    if (f === "owner_id" || f === "assignee_id") return Object.fromEntries(users.filter((u) => u.active).map((u) => [u.id, u.name]));
    if (f === "stage_id") return Object.fromEntries(pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${p.name} · ${s.name}`])));
    if (f === "pipeline_id") return Object.fromEntries(pipelines.map((p) => [p.id, p.name]));
    if (f.startsWith("custom.")) { const cf = custom.find((c) => c.key === f.slice(7)); if (cf && (cf.type === "select" || cf.type === "multiselect")) return Object.fromEntries(cf.options.map((o) => [o, o])); return null; }
    return ENUMS[f] ?? null;
  };
  return (
    <div className="col">
      {value.conditions.length > 1 && (
        <div className="row small"><span className="muted">Mostrar registros que cumplan</span><select className="input sm" style={{ width: "auto" }} value={value.logic} onChange={(e) => onChange({ ...value, logic: e.target.value as "and" | "or" })}><option value="and">todas las condiciones</option><option value="or">cualquier condición</option></select></div>
      )}
      {value.conditions.map((c, i) => {
        const kind = kindOf(c.field);
        const ops = OPS_BY_KIND[kind] ?? OPS_BY_KIND.text!;
        const en = enumFor(c.field);
        return (
          <div className="filter-row" key={i}>
            <select className="input sm" value={c.field} onChange={(e) => { const f = e.target.value; const k = kindOf(f); update(i, { field: f, op: (OPS_BY_KIND[k] ?? [])[0] ?? "eq", value: "" }); }}>
              {Object.keys(fields).map((f) => <option key={f} value={f}>{FIELD_LABEL[f] ?? f}</option>)}
              {custom.length > 0 && <optgroup label="Campos personalizados">{custom.map((cf) => <option key={cf.key} value={`custom.${cf.key}`}>{cf.label}</option>)}</optgroup>}
            </select>
            <select className="input sm" value={c.op} onChange={(e) => update(i, { op: e.target.value })}>{ops.map((o) => <option key={o} value={o}>{OPS_LABEL[o] ?? o}</option>)}</select>
            {NO_VALUE.has(c.op) ? <span /> : en && (c.op === "eq" || c.op === "neq") ? (
              <select className="input sm" value={String(c.value ?? "")} onChange={(e) => update(i, { value: e.target.value })}><option value="">—</option>{Object.entries(en).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            ) : (
              <input className="input sm" type={kind === "number" || c.op.endsWith("_days") ? "number" : kind === "date" && (c.op === "before" || c.op === "after") ? "date" : "text"} value={String(c.value ?? "")} onChange={(e) => update(i, { value: e.target.value })} placeholder={c.op === "in" || c.op === "not_in" ? "valor1, valor2" : c.op.endsWith("_days") ? "días" : ""} />
            )}
            <button className="iconbtn" onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })} aria-label="Quitar condición"><X size={15} /></button>
          </div>
        );
      })}
      <div><button className="btn sm ghost" onClick={() => onChange({ ...value, conditions: [...value.conditions, { field: Object.keys(fields)[0] ?? "name", op: "contains", value: "" }] })}><Plus />Añadir condición</button></div>
    </div>
  );
}

export function describeFilters(g: FilterGroup | undefined): string {
  if (!g?.conditions?.length) return "";
  return g.conditions.map((c) => `${FIELD_LABEL[c.field] ?? c.field.replace("custom.", "")} ${OPS_LABEL[c.op] ?? c.op}${NO_VALUE.has(c.op) ? "" : ` ${Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? "")}`}`).join(g.logic === "or" ? " o " : " y ");
}
