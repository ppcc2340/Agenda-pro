/**
 * Piezas de la tabla tipo Excel: editor de etiquetas dentro del desplegable (como monday), formato condicional,
 * formato de número, cambio de tipo con conversión, editores emergentes (etiquetas, texto largo, rango de fechas,
 * relación) y la ayuda de atajos.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, Eye, EyeOff, Trash2, Plus, X, ArrowUp, ArrowDown, Search } from "lucide-react";
import { api } from "../api";
import { Modal, Field, useToast, errorMessage } from "./ui";
import { PALETTE } from "../lib/board";
import { COND_OPS, type CondRule, type NumFormat, formatNumber, norm } from "../lib/grid";
import { pillStyle } from "../lib/colors";

export function ColorPicker({ value, onPick, onClose }: { value: string; onPick: (c: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }; setTimeout(() => document.addEventListener("mousedown", h), 0); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  return <div ref={ref} className="cpick">{PALETTE.map((c) => <button key={c} type="button" style={{ background: c, outline: c === value ? "2px solid var(--ink)" : undefined }} onClick={() => onPick(c)} aria-label={c} />)}</div>;
}

/* ------------------------------------------------------------------ editor de etiquetas */
export interface LabelItem { key: string; label: string; color: string; kind: "builtin" | "extra" | "custom" | "stage"; hidden?: boolean; done?: boolean; base?: string; isNew?: boolean }
export interface LabelCaps { canAdd: boolean; canDelete: (it: LabelItem) => boolean; canHide: boolean; hasDone?: boolean; bases?: { key: string; label: string }[]; note?: string; newKind: LabelItem["kind"] }

/** Modo «Editar etiquetas» dentro del propio desplegable: renombrar, color, arrastrar para ordenar, ocultar, añadir, quitar. */
export function LabelEditor({ items: initial, caps, onCancel, onSave }: { items: LabelItem[]; caps: LabelCaps; onCancel: () => void; onSave: (items: LabelItem[], removed: LabelItem[]) => Promise<void> }) {
  const [items, setItems] = useState<LabelItem[]>(initial);
  const [removed, setRemoved] = useState<LabelItem[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, p: Partial<LabelItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (from: number, to: number) => setItems((xs) => { const a = [...xs]; const [m] = a.splice(from, 1); a.splice(to, 0, m!); return a; });
  const add = () => setItems((xs) => [...xs, { key: `new_${Date.now().toString(36)}`, label: "", color: PALETTE[(xs.length * 3 + 1) % PALETTE.length]!, kind: caps.newKind, isNew: true, base: caps.bases?.[0]?.key }]);
  const save = async () => {
    if (items.some((x) => !x.label.trim())) return;
    const seen = new Set<string>(); for (const x of items) { const k = norm(x.label); if (seen.has(k)) return; seen.add(k); }
    setBusy(true); try { await onSave(items.map((x) => ({ ...x, label: x.label.trim() })), removed); } finally { setBusy(false); }
  };
  const dupes = (() => { const c = new Map<string, number>(); items.forEach((x) => c.set(norm(x.label), (c.get(norm(x.label)) ?? 0) + 1)); return c; })();
  return (
    <div className="ledit" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}>
      {items.map((it, i) => (
        <div key={it.key} className={`lrow ${drag === i ? "drag" : ""} ${it.hidden ? "off" : ""}`} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }} onDragEnd={() => setDrag(null)}>
          <GripVertical size={14} className="grip" />
          <span style={{ position: "relative" }}>
            <button type="button" className="swatch" style={{ background: it.color }} onClick={() => setPick(pick === i ? null : i)} aria-label="Color" />
            {pick === i && <ColorPicker value={it.color} onPick={(c) => { upd(i, { color: c }); setPick(null); }} onClose={() => setPick(null)} />}
          </span>
          <input className={`input sm grow ${!it.label.trim() || (dupes.get(norm(it.label)) ?? 0) > 1 ? "bad" : ""}`} value={it.label} maxLength={40} autoFocus={it.isNew} placeholder="Nombre de la etiqueta" onChange={(e) => upd(i, { label: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          {it.kind === "extra" && caps.bases && <select className="input sm" style={{ width: 110 }} title="Se comporta como" value={it.base} onChange={(e) => upd(i, { base: e.target.value })}>{caps.bases.map((b) => <option key={b.key} value={b.key}>≈ {b.label}</option>)}</select>}
          {caps.hasDone && <label className="xs muted" title="Cuenta como hecho"><input type="checkbox" checked={!!it.done} onChange={(e) => upd(i, { done: e.target.checked })} />✓</label>}
          {caps.canHide && it.kind === "builtin" && <button type="button" className="iconbtn" title={it.hidden ? "Mostrar en el desplegable" : "Ocultar del desplegable"} onClick={() => upd(i, { hidden: !it.hidden })}>{it.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
          {caps.canDelete(it) ? <button type="button" className="iconbtn" title="Quitar etiqueta" onClick={() => { if (!it.isNew) setRemoved((r) => [...r, it]); setItems((xs) => xs.filter((_, j) => j !== i)); }} aria-label="Quitar etiqueta"><Trash2 size={14} /></button> : <span style={{ width: 28 }} />}
        </div>
      ))}
      {caps.canAdd && <button type="button" className="btn ghost sm" onClick={add}><Plus />Nueva etiqueta</button>}
      {caps.note && <p className="xs muted" style={{ margin: "4px 2px" }}>{caps.note}</p>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
        <button type="button" className="btn sm" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={save}>Aplicar</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ formato condicional */
export interface GridColumnLite { key: string; label: string; type: string; options?: Record<string, { label: string; color: string }> }
export function CondFormatDialog({ columns, rules: initial, onClose, onSave }: { columns: GridColumnLite[]; rules: CondRule[]; onClose: () => void; onSave: (r: CondRule[]) => void }) {
  const [rules, setRules] = useState<CondRule[]>(initial);
  const upd = (i: number, p: Partial<CondRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const add = () => setRules((rs) => [...rs, { id: Math.random().toString(36).slice(2, 9), column: columns[1]?.key ?? columns[0]!.key, op: "eq", value: "", bg: "#ffe1e4", color: "", scope: "cell", enabled: true }]);
  const move = (i: number, d: number) => setRules((rs) => { const a = [...rs]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j]!, a[i]!]; return a; });
  return (
    <Modal title="Formato condicional" size="lg" onClose={onClose} footer={<><button className="btn" onClick={add}><Plus />Nueva regla</button><span className="grow" /><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => { onSave(rules); onClose(); }}>Guardar</button></>}>
      <p className="small muted mb12">Colorea celdas o filas enteras según su valor, como en Excel. Las reglas se aplican en orden; la primera que coincide decide el color de cada celda.</p>
      {!rules.length && <p className="small">Aún no hay reglas. Ejemplos: «Importe mayor que 50.000 → fila verde», «Cierre previsto: fecha vencida → rojo», «Estado es Urgente → negrita».</p>}
      <div className="col" style={{ gap: 8 }}>
        {rules.map((r, i) => {
          const col = columns.find((c) => c.key === r.column) ?? columns[0]!;
          const ops = COND_OPS.filter((o) => !o.types || o.types.includes(col.type === "name" ? "text" : col.type) || (col.type === "status" && ["eq", "ne"].includes(o.key)));
          const op = COND_OPS.find((o) => o.key === r.op) ?? COND_OPS[0]!;
          const valInput = (k: "value" | "value2") => col.type === "status" && col.options ? <select className="input sm" value={String(r[k] ?? "")} onChange={(e) => upd(i, { [k]: e.target.value })}><option value="">—</option>{Object.entries(col.options).map(([key, o]) => <option key={key} value={key}>{o.label}</option>)}</select> : <input className="input sm" style={{ width: 120 }} type={col.type === "date" && r.op !== "next_days" ? "date" : ["number", "money"].includes(col.type) || r.op === "next_days" ? "number" : "text"} value={String(r[k] ?? "")} onChange={(e) => upd(i, { [k]: e.target.value })} />;
          return (
            <div key={r.id} className={`cfrule ${r.enabled === false ? "off" : ""}`}>
              <input type="checkbox" checked={r.enabled !== false} onChange={(e) => upd(i, { enabled: e.target.checked })} title="Activa" />
              <span className="xs muted">Si</span>
              <select className="input sm" value={r.column} onChange={(e) => upd(i, { column: e.target.value, op: "eq", value: "" })}>{columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
              <select className="input sm" value={r.op} onChange={(e) => upd(i, { op: e.target.value })}>{ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
              {op.arity >= 1 && valInput("value")}
              {op.arity === 2 && <><span className="xs muted">y</span>{valInput("value2")}</>}
              <span className="xs muted">→</span>
              <label className="xs" title="Fondo"><input type="color" value={r.bg || "#ffffff"} onChange={(e) => upd(i, { bg: e.target.value })} /></label>
              <label className="xs" title="Texto"><input type="color" value={r.color || "#323338"} onChange={(e) => upd(i, { color: e.target.value })} /></label>
              <label className="xs"><input type="checkbox" checked={!!r.bold} onChange={(e) => upd(i, { bold: e.target.checked })} />N</label>
              <select className="input sm" value={r.scope ?? "cell"} onChange={(e) => upd(i, { scope: e.target.value as "cell" })}><option value="cell">la celda</option><option value="row">toda la fila</option></select>
              <span className="cfprev" style={{ background: r.bg, color: r.color || undefined, fontWeight: r.bold ? 700 : undefined }}>Ejemplo</span>
              <button className="iconbtn" onClick={() => move(i, -1)} title="Subir" aria-label="Subir"><ArrowUp size={13} /></button>
              <button className="iconbtn" onClick={() => move(i, 1)} title="Bajar" aria-label="Bajar"><ArrowDown size={13} /></button>
              <button className="iconbtn" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} title="Borrar" aria-label="Borrar"><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ formato de columna */
export function NumFormatDialog({ label, numeric, value, onClose, onSave }: { label: string; numeric: boolean; value: NumFormat; onClose: () => void; onSave: (f: NumFormat | null) => void }) {
  const [f, setF] = useState<NumFormat>({ decimals: 0, thousands: true, ...value });
  const set = (p: Partial<NumFormat>) => setF((x) => ({ ...x, ...p }));
  return (
    <Modal title={`Formato de «${label}»`} onClose={onClose} footer={<><button className="btn" onClick={() => { onSave(null); onClose(); }}>Restablecer</button><span className="grow" /><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => { onSave(f); onClose(); }}>Aplicar</button></>}>
      <div className="form-grid" style={{ padding: 0 }}>
        {numeric && <>
          <Field label="Decimales"><input className="input" type="number" min={0} max={6} value={f.decimals ?? 0} onChange={(e) => set({ decimals: Math.max(0, Math.min(6, Number(e.target.value))) })} /></Field>
          <Field label="Separador de miles"><label className="checkbox"><input type="checkbox" checked={f.thousands !== false} onChange={(e) => set({ thousands: e.target.checked })} />1.234.567</label></Field>
          <Field label="Prefijo"><input aria-label="Ej. $" className="input" value={f.prefix ?? ""} maxLength={6} placeholder="Ej. $" onChange={(e) => set({ prefix: e.target.value })} /></Field>
          <Field label="Sufijo / unidad"><div className="row wrap" style={{ gap: 4 }}><input className="input sm" style={{ width: 90 }} value={f.suffix ?? ""} maxLength={8} onChange={(e) => set({ suffix: e.target.value })} />{[" €", " %", " h", " uds"].map((s) => <button key={s} type="button" className="tag" onClick={() => set({ suffix: s })}>{s.trim()}</button>)}</div></Field>
          <Field label="Negativos"><label className="checkbox"><input type="checkbox" checked={!!f.neg_red} onChange={(e) => set({ neg_red: e.target.checked })} />en rojo</label></Field>
          <Field label="Vista previa"><b style={{ color: f.neg_red ? "var(--risk)" : undefined }}>{formatNumber(-1234.5678, f)}</b> · <b>{formatNumber(98765.4321, f)}</b></Field>
        </>}
        <Field label="Alineación"><select className="input" value={f.align ?? ""} onChange={(e) => set({ align: (e.target.value || undefined) as NumFormat["align"] })}><option value="">Automática</option><option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option></select></Field>
        <Field label="Texto largo"><label className="checkbox"><input type="checkbox" checked={!!f.wrap} onChange={(e) => set({ wrap: e.target.checked })} />Ajustar texto (varias líneas)</label></Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ cambio de tipo */
const CHANGE_TYPES: [string, string][] = [["text", "Texto"], ["textarea", "Texto largo"], ["number", "Número"], ["currency", "Importe"], ["percent", "Porcentaje"], ["status", "Estado (etiquetas)"], ["select", "Desplegable"], ["multiselect", "Etiquetas múltiples"], ["date", "Fecha"], ["datetime", "Fecha y hora"], ["timeline", "Línea temporal"], ["boolean", "Casilla"], ["rating", "Valoración"], ["user", "Persona"], ["email", "Email"], ["phone", "Teléfono"], ["url", "Enlace"]];
interface Report { total: number; filled: number; converted: number; lost: number; samples: { before: string; after: string }[]; labels?: { label: string; color: string }[]; options?: string[] }
export function ChangeTypeDialog({ field, onClose, onDone }: { field: { id: string; object: string; key: string; label: string; type: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [type, setType] = useState<string>(field.type === "text" ? "status" : "text");
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRep(null); api.post<Report>("columns/convert-preview", { object: field.object, key: field.key, type }).then(setRep).catch((e) => toast(errorMessage(e), "error")); /* eslint-disable-next-line */ }, [type]);
  const apply = async () => { setBusy(true); try { await api.put(`admin/custom-fields/${field.id}`, { type }); toast(`«${field.label}» ahora es ${CHANGE_TYPES.find((t) => t[0] === type)?.[1]}`, "ok"); await onDone(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); } };
  return (
    <Modal title={`Cambiar el tipo de «${field.label}»`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className={`btn ${rep?.lost ? "danger" : "primary"}`} disabled={busy || !rep || type === field.type} onClick={apply}>{rep?.lost ? `Convertir (se pierden ${rep.lost})` : "Convertir"}</button></>}>
      <Field label="Nuevo tipo"><div className="type-grid">{CHANGE_TYPES.filter((t) => t[0] !== field.type).map(([k, l]) => <button key={k} type="button" className={`type-btn ${type === k ? "active" : ""}`} onClick={() => setType(k)}><b>{l}</b></button>)}</div></Field>
      {!rep ? <p className="small muted">Calculando…</p> : (
        <div className="mt12">
          <p className="small"><b>{rep.converted}</b> de {rep.filled} valores se convierten{rep.lost ? <> · <b style={{ color: "var(--risk-ink)" }}>{rep.lost} no se pueden convertir y quedarán vacíos</b></> : " sin pérdidas"} · {rep.total - rep.filled} celdas vacías.</p>
          {rep.labels && <p className="small">Etiquetas que se crearán: {rep.labels.map((l) => <span key={l.label} className="pill-mini" style={pillStyle(l.color)}>{l.label}</span>)}</p>}
          {rep.options && <p className="small">Opciones: {rep.options.join(", ") || "—"}</p>}
          {rep.samples.length > 0 && <table className="table mt8"><thead><tr><th>Antes</th><th>Después</th></tr></thead><tbody>{rep.samples.map((s, i) => <tr key={i}><td>{s.before}</td><td>{s.after}</td></tr>)}</tbody></table>}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ editores emergentes de celda */
export function Pop({ at, children, onClose, width = 280 }: { at: { x: number; y: number }; children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }; setTimeout(() => document.addEventListener("mousedown", h), 0); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  return <div ref={ref} className="cpop" style={{ left: Math.min(at.x, window.innerWidth - width - 10), top: Math.min(at.y, window.innerHeight - 260), width }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{children}</div>;
}
export function TagsEditor({ value, suggestions, onCommit, onCancel }: { value: string[]; suggestions: string[]; onCommit: (v: string[]) => void; onCancel: () => void }) {
  const [tags, setTags] = useState(value);
  const [text, setText] = useState("");
  const add = (t: string) => { const x = t.trim(); if (x && !tags.includes(x)) setTags([...tags, x]); setText(""); };
  const sug = suggestions.filter((s) => !tags.includes(s) && norm(s).includes(norm(text))).slice(0, 8);
  return (
    <div onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}>
      <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>{tags.map((t) => <span key={t} className="tag">{t}<button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Quitar ${t}`}><X size={11} /></button></span>)}{!tags.length && <span className="xs muted">Sin etiquetas</span>}</div>
      <input aria-label="Escribe y pulsa Enter…" className="input sm" autoFocus placeholder="Escribe y pulsa Enter…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (text.trim()) add(text); else onCommit(tags); } if (e.key === "Backspace" && !text && tags.length) setTags(tags.slice(0, -1)); }} />
      {sug.length > 0 && <div className="row wrap mt8" style={{ gap: 4 }}>{sug.map((s) => <button key={s} type="button" className="tag" onClick={() => add(s)}>+ {s}</button>)}</div>}
      <div className="row mt8" style={{ justifyContent: "flex-end", gap: 6 }}><button type="button" className="btn sm" onClick={onCancel}>Cancelar</button><button type="button" className="btn primary sm" onClick={() => onCommit(text.trim() ? [...tags, text.trim()] : tags)}>Guardar</button></div>
    </div>
  );
}
export function LongTextEditor({ value, onCommit, onCancel }: { value: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  return <div onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onCommit(v); }}><textarea className="input" autoFocus style={{ minHeight: 120, width: "100%" }} value={v} onChange={(e) => setV(e.target.value)} /><div className="row mt8" style={{ gap: 6 }}><span className="xs muted grow">Ctrl+Enter para guardar</span><button className="btn sm" onClick={onCancel}>Cancelar</button><button className="btn primary sm" onClick={() => onCommit(v)}>Guardar</button></div></div>;
}
export function RangeEditor({ value, onCommit, onCancel }: { value: { from?: string; to?: string } | null; onCommit: (v: { from: string; to: string } | null) => void; onCancel: () => void }) {
  const [a, setA] = useState(value?.from ?? ""); const [b, setB] = useState(value?.to ?? "");
  return <div onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}><div className="row" style={{ gap: 6 }}><input className="input sm" type="date" autoFocus value={a} onChange={(e) => { setA(e.target.value); if (!b || e.target.value > b) setB(e.target.value); }} /><span>–</span><input className="input sm" type="date" value={b} min={a} onChange={(e) => setB(e.target.value)} /></div><div className="row mt8" style={{ justifyContent: "flex-end", gap: 6 }}><button className="btn sm" onClick={() => onCommit(null)}>Vaciar</button><button className="btn sm" onClick={onCancel}>Cancelar</button><button className="btn primary sm" disabled={!a} onClick={() => onCommit({ from: a, to: b || a })}>Guardar</button></div></div>;
}
export function RelationPicker({ endpoint, labelOf, onPick, onCancel }: { endpoint: string; labelOf: (r: Record<string, unknown>) => string; onPick: (r: Record<string, unknown> | null) => void; onCancel: () => void }) {
  const [q, setQ] = useState(""); const [items, setItems] = useState<Record<string, unknown>[]>([]);
  useEffect(() => { const t = setTimeout(() => { api.get<{ items: Record<string, unknown>[] }>(`${endpoint}?q=${encodeURIComponent(q)}&page_size=8`).then((r) => setItems(r.items)).catch(() => undefined); }, 150); return () => clearTimeout(t); }, [q, endpoint]);
  return <div onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); if (e.key === "Enter" && items[0]) onPick(items[0]); }}><div className="row" style={{ gap: 6 }}><Search size={14} className="muted" /><input aria-label="Buscar…" className="input sm grow" autoFocus placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} /></div><div className="col mt8" style={{ gap: 2 }}>{items.map((r) => <button key={String(r.id)} type="button" className="pick" onClick={() => onPick(r)}>{labelOf(r)}</button>)}<button type="button" className="pick muted" onClick={() => onPick(null)}>— Quitar —</button></div></div>;
}

export const SHORTCUTS: [string, string][] = [
  ["Flechas · Tab · Enter", "Moverse entre celdas"], ["Mayús + flechas / clic", "Seleccionar un rango"], ["Enter · F2 · doble clic", "Editar la celda"], ["Escribir", "Reemplazar el contenido"], ["Espacio", "Marcar casilla / abrir etiquetas"],
  ["Supr / Retroceso", "Vaciar el rango"], ["Ctrl+C · Ctrl+X · Ctrl+V", "Copiar, cortar y pegar (también desde Excel)"], ["Ctrl+D", "Rellenar hacia abajo"], ["Arrastrar el cuadradito", "Rellenar o continuar la serie"], ["Ctrl+Z · Ctrl+Y", "Deshacer y rehacer"], ["Ctrl+A", "Seleccionar todo"], ["Esc", "Cancelar / quitar selección"],
];
