/** Selector de una lista de valores en las fichas: muestra todas las etiquetas (no solo las de fábrica). */
import { usePicklist, resolveOption } from "../lib/picklists";

export function PicklistSelect({ pkey, value, custom, label, onChange }: { pkey: string; value: string | null | undefined; custom?: Record<string, unknown> | null; label: string; onChange: (role: string, labelId: string | null) => void }) {
  const p = usePicklist(pkey);
  if (!p) return <span>{value ?? "—"}</span>;
  const field = p.field;
  const cur = resolveOption(p, value, custom?.[`_lbl_${field}`]);
  return (
    <select aria-label={label} className="input sm" value={cur?.id ?? ""} onChange={(e) => { const o = p.options.find((x) => x.id === e.target.value); if (o) onChange(o.role, o.id === o.role ? null : o.id); }}>
      {!cur && <option value="">—</option>}
      {p.options.filter((o) => !o.hidden || o.id === cur?.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}
/** Parche para guardar una etiqueta: el comportamiento en su campo y la etiqueta concreta en custom._lbl_<campo>. */
export const picklistPatch = (field: string, role: string, labelId: string | null, extra: Record<string, unknown> = {}) => ({ [field]: role, custom: { [`_lbl_${field}`]: labelId }, ...extra });
