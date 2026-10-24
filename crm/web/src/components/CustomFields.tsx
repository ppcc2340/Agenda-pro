import { useApp, type CustomField } from "../lib/app";
import { Field } from "./ui";

/** Renders custom field inputs for an object, grouped by section, honoring show_if dependencies. */
export function CustomFieldsForm({ object, value, onChange, record }: { object: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; record?: Record<string, unknown> }) {
  const { customFields, users } = useApp();
  const defs = customFields.filter((f) => f.object === object);
  if (!defs.length) return null;
  const visible = defs.filter((d) => { if (!d.show_if) return true; const dep = d.show_if.field.startsWith("custom.") ? value[d.show_if.field.slice(7)] : record?.[d.show_if.field]; return String(dep ?? "") === d.show_if.value; });
  const sections = Array.from(new Set(visible.map((d) => d.section ?? "")));
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <>
      {sections.map((s) => (
        <div key={s} className="form-grid full" style={{ gridColumn: "1 / -1", padding: 0 }}>
          <div className="form-section">{s || "Campos personalizados"}</div>
          {visible.filter((d) => (d.section ?? "") === s).map((d) => <CustomInput key={d.id} def={d} value={value[d.key]} onChange={(v) => set(d.key, v)} users={users} />)}
        </div>
      ))}
    </>
  );
}

function CustomInput({ def: d, value, onChange, users }: { def: CustomField; value: unknown; onChange: (v: unknown) => void; users: { id: string; name: string; active: boolean }[] }) {
  const label = d.required ? `${d.label} *` : d.label;
  const v = value === null || value === undefined ? "" : value;
  switch (d.type) {
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
    case "boolean": return v === true || v === 1 || v === "true" ? "Sí" : "No";
    case "currency": return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Number(v));
    case "percent": return `${v}%`;
    case "multiselect": return Array.isArray(v) ? v.join(", ") : String(v);
    case "user": return userName(String(v));
    default: return String(v);
  }
}
