/**
 * Ficha de un registro dibujada según su diseño (Ajustes → Diseño de fichas): secciones plegables, campos nativos
 * y personalizados en el orden elegido, ayudas, condiciones de visibilidad y edición en línea. Respeta la seguridad
 * por campo: los ocultos no llegan y los de solo lectura muestran un candado.
 */
import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, Lock, HelpCircle, Pencil, Check, X } from "lucide-react";
import { useApp, type CustomField } from "../lib/app";
import { useLayout, BUILTIN_OPTIONS, condHolds, type FieldInfo, type LayoutField } from "../lib/layout";
import { fmtDate, fmtMoney, relTime } from "../lib/format";
import { Picker, ScoreBar } from "./ui";
import { CustomInput, formatCustom } from "./CustomFields";
import { ChannelList, type Channel } from "./ChannelList";

type Rec = Record<string, unknown>;
const READONLY_TYPES = new Set(["formula", "mirror", "autonumber", "creation_log", "last_updated", "button"]);
const SYSTEM_RO = new Set(["created_at", "updated_at", "score", "last_activity_at", "closed_at", "resolved_at", "sla_due_at", "signed_at", "number", "stage_entered_at", "next_activity_at", "completed_at", "requested_at", "status_contract"]);
const NAME_OF: Record<string, string> = { owner_id: "owner_name", assignee_id: "assignee_name", legal_owner_id: "legal_owner_name", company_id: "company_name", contact_id: "contact_name", stage_id: "stage_name", counterparty_company_id: "counterparty_name", type_id: "type_name", deal_id: "deal_name", parent_id: "parent_name", pipeline_id: "pipeline_name" };

export function LayoutPanel({ object, record, onPatch, editable = true, extra }: { object: string; record: Rec; onPatch: (p: Rec) => Promise<void> | void; editable?: boolean; extra?: Record<string, ReactNode> }) {
  const eff = useLayout(object);
  const { customFields, userName, pipelines, access } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!eff) return <p className="small muted">Cargando ficha…</p>;
  const info = new Map(eff.fields.map((f) => [f.key, f]));
  const customOf = (k: string) => customFields.find((c) => c.object === object && `custom.${c.key}` === k);
  return (
    <div className="lay-panel">
      {eff.layout.sections.map((s) => {
        const fields = s.fields.filter((f) => info.has(f.key) && condHolds(f.show_if ?? null, record));
        if (!fields.length) return null;
        const isOpen = open[s.id] ?? !s.collapsed;
        return (
          <div key={s.id} className="lay-sec">
            <button type="button" className="lay-sec-h" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !isOpen }))}><ChevronDown size={14} style={{ transform: isOpen ? "none" : "rotate(-90deg)" }} />{s.title}<span className="xs muted">{fields.length}</span></button>
            {isOpen && <dl className={`kv lay-kv ${s.columns === 2 ? "two" : ""}`}>
              {fields.map((f) => { const fi = info.get(f.key)!; return <Fragment key={f.key}><dt>{fi.label}{f.help && <span title={f.help} aria-label={f.help} className="lay-help"><HelpCircle size={11} /></span>}{(fi.access === "read") && <Lock size={10} className="muted" aria-label="Solo lectura" />}</dt><dd>{extra?.[f.key] ?? <FieldValue object={object} fi={fi} lf={f} record={record} custom={customOf(f.key)} canEdit={editable && fi.access !== "read" && access(object, f.key) === "edit"} onPatch={onPatch} userName={userName} stageName={(id) => pipelines.flatMap((p) => p.stages).find((x) => x.id === id)?.name} />}</dd></Fragment>; })}
            </dl>}
          </div>
        );
      })}
    </div>
  );
}

function FieldValue({ object, fi, lf, record, custom, canEdit, onPatch, userName, stageName }: { object: string; fi: FieldInfo; lf: LayoutField; record: Rec; custom?: CustomField; canEdit: boolean; onPatch: (p: Rec) => Promise<void> | void; userName: (id: string) => string; stageName: (id: string) => string | undefined }) {
  const { users } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(null);
  const key = fi.key;
  const isCustom = key.startsWith("custom.");
  const value = isCustom ? ((record.custom as Rec | undefined) ?? {})[key.slice(7)] : record[key];
  const ro = !canEdit || READONLY_TYPES.has(fi.type) || SYSTEM_RO.has(key) || (object === "deal" && key === "status") || (object === "contract" && key === "status") || key === "pipeline_id";
  const save = async (v: unknown) => {
    setEditing(false);
    if (JSON.stringify(v ?? null) === JSON.stringify(value ?? null)) return;
    if (object === "contact" && key === "lead_status" && v === "unqualified") { const r = prompt("Motivo de descalificación"); if (!r) return; await onPatch({ lead_status: v, disqualify_reason: r }); return; }
    await onPatch(isCustom ? { custom: { ...((record.custom as Rec) ?? {}), [key.slice(7)]: v } } : { [key]: v });
  };
  // emails y teléfonos del contacto: lista con principal
  if (object === "contact" && (key === "email" || key === "phone")) return <ChannelList kind={key} items={record[key === "email" ? "emails" : "phones"] as Channel[] | undefined} fallback={(value as string | null) ?? null} onSave={async (list) => { if (canEdit) await onPatch({ [key === "email" ? "emails" : "phones"]: list }); }} />;
  if (key === "score") return <ScoreBar value={Number(value) || 0} />;
  const opts = fi.options_ref ? BUILTIN_OPTIONS[fi.options_ref] : undefined;
  const display = (): ReactNode => {
    if (isCustom && custom) { const t = formatCustom(custom, value, userName); return t || <span className="muted">—</span>; }
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <span className="muted">—</span>;
    if (NAME_OF[key] && record[NAME_OF[key]!]) return String(record[NAME_OF[key]!]);
    if (key === "stage_id") return stageName(String(value)) ?? String(value);
    if (fi.type === "user") return userName(String(value)) || String(value);
    if (opts) return opts[String(value)] ?? String(value);
    if (fi.type === "date" || fi.type === "creation_log" || fi.type === "last_updated" || /_at$|_date$/.test(key)) return key === "last_activity_at" ? relTime(String(value)) : fmtDate(String(value));
    if (key === "amount" || key === "revenue" || key === "annual_value" || key === "total_value") return fmtMoney(Number(value), String(record.currency ?? "EUR"));
    if (fi.type === "boolean") return value === true || value === 1 ? "Sí" : "No";
    if (Array.isArray(value)) return <span className="row wrap" style={{ gap: 3 }}>{(value as unknown[]).map((t) => <span key={String(t)} className="tag">{String(t)}</span>)}</span>;
    if (/^https?:\/\//.test(String(value))) return <a href={String(value)} target="_blank" rel="noreferrer">{String(value).replace(/^https?:\/\//, "").slice(0, 40)}</a>;
    return String(value);
  };
  if (ro) return <span className="lay-val">{display()}</span>;
  if (!editing) return <button type="button" className="lay-val edit" title="Editar" onClick={() => { setDraft(value ?? null); setEditing(true); }}>{display()}<Pencil size={11} className="lay-pen" /></button>;
  const actions = <span className="row" style={{ gap: 2 }}><button type="button" className="iconbtn xs" aria-label="Guardar" onClick={() => save(draft)}><Check size={13} /></button><button type="button" className="iconbtn xs" aria-label="Cancelar" onClick={() => setEditing(false)}><X size={13} /></button></span>;
  const keys = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) save(draft); if (e.key === "Escape") setEditing(false); };
  if (isCustom && custom) return <div className="lay-edit" onKeyDown={keys}><CustomInput def={custom} value={draft} onChange={setDraft} users={users} />{actions}</div>;
  let input: ReactNode;
  if (key === "company_id" || key === "counterparty_company_id" || key === "parent_id") input = <Picker kind="company" autoFocus value={draft as string | null} onChange={(id) => setDraft(id)} />;
  else if (key === "contact_id") input = <Picker kind="contact" autoFocus value={draft as string | null} onChange={(id) => setDraft(id)} />;
  else if (fi.type === "user") input = <select className="input sm" autoFocus value={String(draft ?? "")} onChange={(e) => save(e.target.value || null)}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
  else if (opts) input = <select className="input sm" autoFocus value={String(draft ?? "")} onChange={(e) => save(e.target.value)}>{Object.entries(opts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>;
  else if (fi.type === "number") input = <input className="input sm" type="number" step="any" autoFocus value={draft == null ? "" : String(draft)} onChange={(e) => setDraft(e.target.value === "" ? null : Number(e.target.value))} />;
  else if (fi.type === "date") input = <input className="input sm" type="date" autoFocus value={String(draft ?? "").slice(0, 10)} onChange={(e) => setDraft(e.target.value || null)} />;
  else if (fi.type === "boolean") input = <label className="checkbox"><input type="checkbox" autoFocus checked={draft === true || draft === 1} onChange={(e) => save(e.target.checked)} />Sí</label>;
  else if (key === "description" || key === "address") input = <textarea className="input" autoFocus value={String(draft ?? "")} onChange={(e) => setDraft(e.target.value)} />;
  else if (key === "tags") input = <input className="input sm" autoFocus value={Array.isArray(draft) ? (draft as string[]).join(", ") : ""} onChange={(e) => setDraft(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} placeholder="separadas por comas" />;
  else input = <input className="input sm" autoFocus value={String(draft ?? "")} onChange={(e) => setDraft(e.target.value || null)} />;
  void lf;
  return <div className="lay-edit" onKeyDown={keys}>{input}{actions}</div>;
}
