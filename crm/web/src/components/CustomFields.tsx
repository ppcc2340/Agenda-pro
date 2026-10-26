import { useApp, type CustomField, type StatusLabel } from "../lib/app";
import { locale } from "../lib/prefs";
import { Field } from "./ui";

/** Renders custom field inputs for an object, grouped by section, honoring show_if dependencies. */
export function CustomFieldsForm({ object, value, onChange, record, allow, readOnly }: { object: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; record?: Record<string, unknown>; allow?: (d: CustomField) => boolean; readOnly?: (d: CustomField) => boolean }) {
  const { customFields, users } = useApp();
  const defs = customFields.filter((f) => f.object === object && !["formula", "mirror", "autonumber", "creation_log", "last_updated", "button"].includes(f.type) && (!allow || allow(f)));
  if (!defs.length) return null;
  const visible = defs.filter((d) => { if (!d.show_if) return true; const dep = d.show_if.field.startsWith("custom.") ? value[d.show_if.field.slice(7)] : record?.[d.show_if.field]; return String(dep ?? "") === d.show_if.value; });
  const sections = Array.from(new Set(visible.map((d) => d.section ?? "")));
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <>
      {sections.map((s) => (
        <div key={s} className="form-grid full" style={{ gridColumn: "1 / -1", padding: 0 }}>
          <div className="form-section">{s || "Campos personalizados"}</div>
          {visible.filter((d) => (d.section ?? "") === s).map((d) => readOnly?.(d) ? <fieldset key={d.id} disabled className="lay-ro" title="Solo lectura para tu rol"><CustomInput def={d} value={value[d.key]} onChange={() => undefined} users={users} /></fieldset> : <CustomInput key={d.id} def={d} value={value[d.key]} onChange={(v) => set(d.key, v)} users={users} />)}
        </div>
      ))}
    </>
  );
}

export function CustomInput({ def: d, value, onChange, users }: { def: CustomField; value: unknown; onChange: (v: unknown) => void; users: { id: string; name: string; active: boolean }[] }) {
  const label = d.required ? `${d.label} *` : d.label;
  const v = value === null || value === undefined ? "" : value;
  switch (d.type) {
    case "status": { const labels = ((d.settings ?? {}).labels as StatusLabel[] | undefined) ?? []; return <Field label={label}><select className="input" value={String(v)} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></Field>; }
    case "rating": { const max = Number((d.settings ?? {}).max ?? 5); return <Field label={label}><span className="rating">{Array.from({ length: max }, (_, i) => <button type="button" key={i} className={i < Number(v || 0) ? "on" : ""} onClick={() => onChange(Number(v || 0) === i + 1 ? 0 : i + 1)}>★</button>)}</span></Field>; }
    case "timeline": { const o = (typeof v === "object" && v ? v : {}) as { from?: string; to?: string }; return <Field label={label}><div className="row"><input className="input" type="date" value={o.from ?? ""} onChange={(e) => onChange(e.target.value ? { from: e.target.value, to: o.to && o.to >= e.target.value ? o.to : e.target.value } : null)} /><span className="muted">→</span><input className="input" type="date" value={o.to ?? ""} min={o.from} onChange={(e) => onChange(o.from ? { from: o.from, to: e.target.value } : null)} /></div></Field>; }
    case "textarea": return <Field label={label} full><textarea className="input" value={String(v)} onChange={(e) => onChange(e.target.value)} /></Field>;
    case "number": case "currency": case "percent": return <Field label={label}><input className="input" type="number" step="any" value={String(v)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /></Field>;
    case "date": return <Field label={label}><input className="input" type="date" value={String(v).slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} /></Field>;
    case "datetime": return <Field label={label}><input className="input" type="datetime-local" value={String(v).slice(0, 16)} onChange={(e) => onChange(e.target.value || null)} /></Field>;
    case "boolean": return <Field label={label}><label className="checkbox"><input type="checkbox" checked={v === true || v === 1 || v === "true"} onChange={(e) => onChange(e.target.checked)} /> Sí</label></Field>;
    case "select": return <Field label={label}><select className="input" value={String(v)} onChange={(e) => onChange(e.target.value || null)}><option value="">—</option>{d.options.map((o) => <option key={o}>{o}</option>)}</select></Field>;
    case "multiselect": { const arr = Array.isArray(v) ? (v as string[]) : []; return <Field label={label}><div className="row wrap">{d.options.map((o) => <label key={o} className="checkbox small"><input type="checkbox" checked={arr.includes(o)} onChange={(e) => onChange(e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} />{o}</label>)}</div></Field>; }
    case "user": return <Field label={label}><select className="input" value={String(v)} onChange={(e) => onChange(e.target.value || null)}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>;
    case "url": case "email": case "phone": return <Field label={label}><input className="input" type={d.type === "phone" ? "tel" : d.type} value={String(v)} onChange={(e) => onChange(e.target.value)} /></Field>;
    default: return <Field label={label}><input className="input" value={String(v)} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
}

export function formatCustom(def: CustomField, v: unknown, userName: (id: string) => string): string {
  if (v === null || v === undefined || v === "") return "";
  switch (def.type) {
    case "status": return (((def.settings ?? {}).labels as StatusLabel[] | undefined) ?? []).find((l) => l.id === Number(v))?.label ?? String(v);
    case "rating": return "★".repeat(Number(v));
    case "timeline": { const o = v as { from?: string; to?: string }; return `${o.from ?? ""} – ${o.to ?? ""}`; }
    case "mirror": return Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Sí" : "No") : String(v);
    case "formula": return typeof v === "boolean" ? (v ? "Sí" : "No") : String(v);
    case "creation_log": case "last_updated": return new Date(String(v)).toLocaleString(locale());
    case "button": return "";
    case "boolean": return v === true || v === 1 || v === "true" ? "Sí" : "No";
    case "currency": return new Intl.NumberFormat(locale(), { style: "currency", currency: "EUR" }).format(Number(v));
    case "percent": return `${v}%`;
    case "multiselect": return Array.isArray(v) ? v.join(", ") : String(v);
    case "user": return userName(String(v));
    default: return String(v);
  }
}
