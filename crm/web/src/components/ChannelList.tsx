/** Varios emails o teléfonos por contacto, con etiqueta y principal (el principal se usa para enviar y llamar). */
import { useState } from "react";
import { Plus, Star, X, Pencil, Check } from "lucide-react";

export interface Channel { value: string; label?: string; primary?: boolean }
const LABELS = ["Trabajo", "Personal", "Móvil", "Oficina", "Facturación", "Otro"];

export function ChannelList({ kind, items, fallback, onSave }: { kind: "email" | "phone"; items: Channel[] | null | undefined; fallback: string | null; onSave: (list: Channel[]) => Promise<void> }) {
  const list: Channel[] = items && items.length ? items : fallback ? [{ value: fallback, label: "Trabajo", primary: true }] : [];
  const [edit, setEdit] = useState<Channel[] | null>(null);
  const href = (v: string) => (kind === "email" ? `mailto:${v}` : `tel:${v.replace(/[^\d+]/g, "")}`);
  if (!edit) return (
    <div className="chlist">
      {list.length ? list.map((c) => <div key={c.value} className="row" style={{ gap: 6 }}><a href={href(c.value)}>{c.value}</a>{c.label && <span className="xs muted">{c.label}</span>}{c.primary && list.length > 1 && <span className="badge xs" title="Principal">principal</span>}</div>) : <span className="muted">—</span>}
      <button className="iconbtn xs" aria-label={kind === "email" ? "Editar emails" : "Editar teléfonos"} title="Editar" onClick={() => setEdit(list.map((c) => ({ ...c })))}><Pencil size={13} /></button>
    </div>
  );
  const upd = (i: number, p: Partial<Channel>) => setEdit((xs) => xs!.map((c, j) => (j === i ? { ...c, ...p } : p.primary ? { ...c, primary: false } : c)));
  return (
    <div className="col" style={{ gap: 6 }}>
      {edit.map((c, i) => (
        <div key={i} className="row" style={{ gap: 4 }}>
          <button className={`iconbtn xs ${c.primary ? "on" : ""}`} title={c.primary ? "Principal" : "Marcar como principal"} aria-pressed={!!c.primary} onClick={() => upd(i, { primary: true })}><Star size={13} fill={c.primary ? "currentColor" : "none"} /></button>
          <input className="input sm grow" type={kind === "email" ? "email" : "tel"} value={c.value} aria-label={kind === "email" ? "Email" : "Teléfono"} onChange={(e) => upd(i, { value: e.target.value })} />
          <select className="input sm" style={{ width: 110 }} value={c.label ?? "Trabajo"} aria-label="Etiqueta" onChange={(e) => upd(i, { label: e.target.value })}>{LABELS.map((l) => <option key={l}>{l}</option>)}</select>
          <button className="iconbtn xs" aria-label="Quitar" onClick={() => setEdit((xs) => xs!.filter((_, j) => j !== i))}><X size={13} /></button>
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn ghost sm" onClick={() => setEdit((xs) => [...xs!, { value: "", label: kind === "phone" ? "Móvil" : "Trabajo", primary: !xs!.length }])}><Plus />Añadir</button>
        <span className="grow" />
        <button className="btn sm" onClick={() => setEdit(null)}>Cancelar</button>
        <button className="btn primary sm" onClick={async () => { await onSave(edit.filter((c) => c.value.trim())); setEdit(null); }}><Check />Guardar</button>
      </div>
    </div>
  );
}
