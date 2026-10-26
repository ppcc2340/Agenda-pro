/**
 * Editor de una lista de valores: todas las etiquetas se pueden renombrar, recolorear, ordenar, ocultar, añadir y
 * borrar (también las de fábrica). Cada etiqueta declara su «comportamiento», que es lo que entiende la lógica del
 * CRM; al borrar una etiqueta en uso se elige a cuál se mueven sus registros.
 */
import { useEffect, useMemo, useState } from "react";
import { GripVertical, Eye, EyeOff, Trash2, Plus, AlertTriangle, Undo2 } from "lucide-react";
import { ColorPicker } from "./GridDialogs";
import { useToast, errorMessage } from "./ui";
import { PALETTE } from "../lib/board";
import { usePicklist, savePicklist, getPicklist, type PicklistOption } from "../lib/picklists";
import { inkOn } from "../lib/colors";

type Draft = PicklistOption & { isNew?: boolean };

export function PicklistEditor({ pkey, compact, onCancel, onSaved }: { pkey: string; compact?: boolean; onCancel?: () => void; onSaved?: () => void }) {
  const p = usePicklist(pkey);
  const toast = useToast();
  const [items, setItems] = useState<Draft[]>(() => (p?.options ?? []).map((o) => ({ ...o })));
  const [removed, setRemoved] = useState<Record<string, string>>({}); // id eliminada → id destino ("" = sin elegir)
  const [pick, setPick] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (p && !items.length) setItems(p.options.map((o) => ({ ...o }))); }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  const roles = p?.roles ?? [];
  const roleLabel = (k: string) => roles.find((r) => r.key === k)?.label ?? k;
  const usage = p?.usage ?? {};
  const uncovered = useMemo(() => roles.filter((r) => !items.some((o) => o.role === r.key && !o.hidden)), [roles, items]);
  if (!p) return <p className="small muted">Cargando…</p>;
  const upd = (i: number, patch: Partial<Draft>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (from: number, to: number) => setItems((xs) => { const a = [...xs]; const [m] = a.splice(from, 1); a.splice(to, 0, m!); return a; });
  const add = () => setItems((xs) => [...xs, { id: `new_${Date.now().toString(36)}`, label: "", color: PALETTE[(xs.length * 3 + 1) % PALETTE.length]!, role: roles[0]?.key ?? "", position: xs.length, isNew: true }]);
  const del = (i: number) => {
    const it = items[i]!; setItems((xs) => xs.filter((_, j) => j !== i));
    if (!it.isNew && (usage[it.id] ?? 0) > 0) setRemoved((r) => ({ ...r, [it.id]: items.find((x, j) => j !== i && x.role === it.role)?.id ?? "" }));
  };
  const restore = (id: string) => { const o = p.options.find((x) => x.id === id); if (o) setItems((xs) => [...xs, { ...o }]); setRemoved((r) => { const n = { ...r }; delete n[id]; return n; }); };
  const dupes = new Set(items.map((x) => x.label.trim().toLowerCase()).filter((l, i, a) => l && a.indexOf(l) !== i));
  const pending = Object.entries(removed).filter(([, to]) => !to || !items.some((x) => x.id === to));
  const valid = items.length > 0 && items.every((x) => x.label.trim()) && !dupes.size && !pending.length;
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      // las etiquetas nuevas reciben id en el servidor: el destino de una reasignación debe ser una existente o se guarda en dos pasos
      const newTargets = Object.values(removed).filter((to) => items.find((x) => x.id === to)?.isNew);
      if (newTargets.length) {
        const first = await savePicklist(pkey, [...items.map((x) => ({ ...x, id: x.isNew ? undefined : x.id })), ...p.options.filter((o) => removed[o.id] !== undefined)], {});
        void first;
        const fresh = getPicklist(pkey)!;
        const map = new Map(items.filter((x) => x.isNew).map((x) => [x.id, fresh.options.find((o) => o.label === x.label.trim())?.id]));
        const r2 = await savePicklist(pkey, fresh.options.filter((o) => removed[o.id] === undefined), Object.fromEntries(Object.entries(removed).map(([k, v]) => [k, map.get(v) ?? v])));
        toast(`Etiquetas guardadas${r2.moved ? ` · ${r2.moved} registros movidos` : ""}`, "ok");
      } else {
        const r = await savePicklist(pkey, items.map((x) => ({ ...x, id: x.isNew ? undefined : x.id })), removed);
        toast(`Etiquetas guardadas${r.moved ? ` · ${r.moved} registros movidos` : ""}`, "ok");
      }
      onSaved?.();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <div className="pledit" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel?.(); }}>
      {!compact && <p className="xs muted" style={{ margin: "0 0 8px" }}>Todas las etiquetas se pueden cambiar o borrar. El <b>comportamiento</b> es lo que entiende el CRM (SLA, conversión, ganado, informes, automatizaciones); varias etiquetas pueden compartirlo.</p>}
      <div className="pl-head xs muted"><span /><span>Etiqueta</span><span>Se comporta como</span><span className="r">Uso</span><span /></div>
      {items.map((it, i) => {
        const used = usage[it.id] ?? 0;
        return (
          <div key={it.id} className={`pl-row ${drag === i ? "drag" : ""} ${it.hidden ? "off" : ""}`} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }} onDragEnd={() => setDrag(null)}>
            <span className="row" style={{ gap: 2 }}><GripVertical size={14} className="grip" aria-hidden />
              <span style={{ position: "relative" }}><button type="button" className="swatch" style={{ background: it.color }} onClick={() => setPick(pick === i ? null : i)} aria-label={`Color de ${it.label || "la etiqueta"}`} />{pick === i && <ColorPicker value={it.color} onPick={(c) => { upd(i, { color: c }); setPick(null); }} onClose={() => setPick(null)} />}</span></span>
            <input className={`input sm ${!it.label.trim() || dupes.has(it.label.trim().toLowerCase()) ? "bad" : ""}`} value={it.label} maxLength={60} autoFocus={it.isNew} placeholder="Nombre" aria-label="Nombre de la etiqueta" onChange={(e) => upd(i, { label: e.target.value })} onKeyDown={(e) => e.key === "Enter" && save()} />
            <select className="input sm" value={it.role} disabled={!it.isNew && used > 0} title={!it.isNew && used > 0 ? "En uso: para cambiar el comportamiento crea otra etiqueta y mueve los registros" : roles.find((r) => r.key === it.role)?.logic ?? ""} aria-label="Comportamiento" onChange={(e) => upd(i, { role: e.target.value })}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <span className="r xs muted">{used || ""}</span>
            <span className="row" style={{ gap: 0 }}>
              <button type="button" className="iconbtn" title={it.hidden ? "Mostrar en los desplegables" : "Ocultar de los desplegables (se conserva)"} aria-label={it.hidden ? "Mostrar" : "Ocultar"} onClick={() => upd(i, { hidden: !it.hidden })}>{it.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              {(p.extensible || it.isNew || it.id !== it.role) && <button type="button" className="iconbtn" title="Borrar etiqueta" aria-label="Borrar etiqueta" onClick={() => del(i)}><Trash2 size={14} /></button>}
            </span>
          </div>
        );
      })}
      {Object.keys(removed).length > 0 && <div className="pl-moves">
        {Object.entries(removed).map(([id, to]) => { const o = p.options.find((x) => x.id === id)!; return (
          <div key={id} className="row wrap small" style={{ gap: 6 }}>
            <span>Mover los <b>{usage[id]}</b> registro(s) de «<s>{o.label}</s>» a</span>
            <select className={`input sm ${!to ? "bad" : ""}`} style={{ width: "auto" }} value={to} onChange={(e) => setRemoved((r) => ({ ...r, [id]: e.target.value }))} aria-label={`Destino de ${o.label}`}>
              <option value="">— elige —</option>{items.filter((x) => x.label.trim()).map((x) => <option key={x.id} value={x.id}>{x.label} ({roleLabel(x.role)})</option>)}
            </select>
            {to && items.find((x) => x.id === to)?.role !== o.role && <span className="xs" style={{ color: "var(--warn, #9a5b00)" }}>cambia su comportamiento a «{roleLabel(items.find((x) => x.id === to)!.role)}»</span>}
            <button type="button" className="btn ghost xs" onClick={() => restore(id)}><Undo2 size={12} />Deshacer</button>
          </div>); })}
      </div>}
      {uncovered.length > 0 && <div className="alert warn small mt8" role="status"><AlertTriangle size={14} /> Sin etiqueta visible para: {uncovered.map((r) => <span key={r.key}><b>{r.label}</b>{r.logic ? ` (${r.logic.toLowerCase()})` : ""}</span>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}. Esa lógica solo se activará si otra regla asigna el comportamiento.</div>}
      <div className="row mt8" style={{ gap: 6 }}>
        {p.extensible ? <button type="button" className="btn ghost sm" onClick={add}><Plus />Nueva etiqueta</button> : <span className="xs muted">Esta lista sigue el ciclo de vida del contrato: sus etiquetas se renombran, recolorean, ordenan u ocultan.</span>}
        <span className="grow" />
        {onCancel && <button type="button" className="btn sm" onClick={onCancel}>Cancelar</button>}
        <button type="button" className="btn primary sm" disabled={!valid || busy} onClick={save}>{busy ? "Guardando…" : "Guardar"}</button>
      </div>
      <div className="pl-preview" aria-hidden>{items.filter((x) => !x.hidden && x.label.trim()).map((x) => <span key={x.id} className="pill-mini" style={{ background: x.color, color: inkOn(x.color) }}>{x.label}</span>)}</div>
    </div>
  );
}
