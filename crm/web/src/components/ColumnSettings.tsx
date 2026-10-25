/**
 * Editor de configuración por tipo de columna (estados con ID estable, fórmulas con vista previa,
 * reflejos con agregación, valoración, botón, autonumeración). Se usa al crear columnas desde el
 * tablero y en Ajustes → Campos.
 */
import { useEffect, useState } from "react";
import { Plus, X, FlaskConical } from "lucide-react";
import { api } from "../api";
import { Field } from "./ui";
import { useApp, type StatusLabel } from "../lib/app";
import { PALETTE } from "../lib/board";

type Any = Record<string, unknown>;
export const TYPE_LABEL: Record<string, string> = {
  status: "Estado (etiquetas de color)", select: "Desplegable (uno)", multiselect: "Desplegable (varios)", text: "Texto", textarea: "Texto largo", number: "Número", currency: "Importe", percent: "Porcentaje", date: "Fecha", datetime: "Fecha y hora", timeline: "Línea temporal",
  user: "Persona", boolean: "Casilla", rating: "Valoración", url: "Enlace", email: "Email", phone: "Teléfono", button: "Botón", formula: "Fórmula", mirror: "Reflejo (mirror)", autonumber: "Autonumeración", creation_log: "Registro de creación", last_updated: "Última actualización",
};
export const TYPE_HELP: Record<string, string> = {
  status: "Se guarda el ID de la etiqueta: renombrar no toca los datos", formula: "Cálculo por fila; dispara automatizaciones", mirror: "Valores de registros conectados con agregación", timeline: "Rango inicio–fin", rating: "Estrellas", button: "Dispara automatizaciones", autonumber: "Secuencia por fecha de creación", creation_log: "Solo lectura", last_updated: "Solo lectura",
};
export const COMPUTED = ["formula", "mirror", "autonumber", "creation_log", "last_updated"];
interface Rel { key: string; label: string; target: string; many: boolean; fields: string[] }
interface Schema { builtin: { id: string; title: string; type: string }[]; custom: { key: string; label: string; type: string }[]; relations: Rel[] }
export const AGG: Record<string, string> = { sum: "Suma", avg: "Media", median: "Mediana", min: "Mínimo", max: "Máximo", count: "Contar", count_not_empty: "Contar no vacíos", list: "Lista", list_unique: "Lista sin repetidos", first: "Primero", earliest: "Fecha más temprana", latest: "Fecha más tardía", all_eq: "TODOS = valor", any_eq: "ALGUNO = valor", none_eq: "NINGUNO = valor", pct_eq: "% = valor (progreso)" };

export function StatusLabelsEditor({ labels, onChange }: { labels: StatusLabel[]; onChange: (l: StatusLabel[]) => void }) {
  const upd = (i: number, p: Partial<StatusLabel>) => onChange(labels.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <div className="col" style={{ gap: 6 }}>
      {labels.map((l, i) => (
        <div key={i} className="row">
          <input type="color" value={l.color} onChange={(e) => upd(i, { color: e.target.value })} style={{ width: 30, height: 28, border: 0, background: "none", padding: 0 }} aria-label="Color" />
          <input className="input sm grow" value={l.label} maxLength={30} onChange={(e) => upd(i, { label: e.target.value })} />
          <label className="checkbox xs" title="Cuenta como hecho para progreso y reflejos"><input type="checkbox" checked={!!l.done} onChange={(e) => upd(i, { done: e.target.checked })} />hecho</label>
          <span className="xs muted" style={{ width: 42 }} title="ID estable (es lo que se guarda)">{l.id ? `id ${l.id}` : "nuevo"}</span>
          <button className="iconbtn" onClick={() => onChange(labels.filter((_, j) => j !== i))} aria-label="Quitar"><X size={14} /></button>
        </div>
      ))}
      <button className="btn ghost sm" onClick={() => onChange([...labels, { id: 0, label: "", color: PALETTE[(labels.length * 3) % PALETTE.length]! }])}><Plus />Añadir etiqueta</button>
    </div>
  );
}

export function ColumnSettings({ object, type, settings, onChange, fieldKey }: { object: string; type: string; settings: Any; onChange: (s: Any) => void; fieldKey?: string }) {
  const { labelSets } = useApp();
  const [schema, setSchema] = useState<Schema | null>(null);
  const [fns, setFns] = useState<Record<string, { sig: string; desc: string; family: string }>>({});
  const [preview, setPreview] = useState<{ value: unknown; error: string | null } | null>(null);
  useEffect(() => { if (["formula", "mirror"].includes(type)) api.get<Schema>(`columns/schema/${object}`).then(setSchema).catch(() => undefined); if (type === "formula") api.get<{ functions: typeof fns }>("columns/types").then((r) => setFns(r.functions)); }, [object, type]);
  const set = (p: Any) => onChange({ ...settings, ...p });
  if (type === "status") {
    const labels = (settings.labels as StatusLabel[] | undefined) ?? [{ id: 0, label: "Pendiente", color: "#c4c4c4" }, { id: 0, label: "En curso", color: "#fdab3d" }, { id: 0, label: "Hecho", color: "#00c875", done: true }];
    return (
      <>
        <Field label="Etiquetas" full hint="Conjunto compartido: las mismas etiquetas e IDs en varios tableros (managed columns)">
          <select className="input sm mb8" value={String(settings.label_set_id ?? "")} onChange={(e) => set({ label_set_id: e.target.value || undefined, labels: e.target.value ? undefined : labels })}><option value="">Etiquetas propias de esta columna</option>{labelSets.map((s) => <option key={s.id} value={s.id}>Conjunto compartido: {s.name}</option>)}</select>
          {!settings.label_set_id && <StatusLabelsEditor labels={labels} onChange={(l) => set({ labels: l })} />}
        </Field>
      </>
    );
  }
  if (type === "rating") return <Field label="Máximo de estrellas"><input className="input" type="number" min={1} max={10} value={Number(settings.max ?? 5)} onChange={(e) => set({ max: Number(e.target.value) })} /></Field>;
  if (type === "button") return <><Field label="Texto del botón"><input className="input" value={String(settings.label ?? "Pulsar")} onChange={(e) => set({ label: e.target.value })} /></Field><Field label="Color"><input type="color" value={String(settings.color ?? "#0073ea")} onChange={(e) => set({ color: e.target.value })} /></Field><p className="xs muted full">Crea una automatización con el disparador «Se pulsa un botón» para darle acción.</p></>;
  if (type === "autonumber") return <><Field label="Prefijo"><input className="input" value={String(settings.prefix ?? "")} onChange={(e) => set({ prefix: e.target.value })} /></Field><Field label="Dígitos"><input className="input" type="number" min={0} max={8} value={Number(settings.pad ?? 0)} onChange={(e) => set({ pad: Number(e.target.value) })} /></Field></>;
  if (type === "formula") {
    const refs = schema ? [...schema.builtin.map((b) => b.title), ...schema.custom.filter((c) => c.key !== fieldKey).map((c) => c.label)] : [];
    const families = Array.from(new Set(Object.values(fns).map((f) => f.family)));
    const ins = (t: string) => set({ expression: `${String(settings.expression ?? "")}${t}` });
    return (
      <>
        <Field label="Fórmula" full hint="Columnas entre llaves: {Importe}. Para líneas temporales {Columna#Start} / {Columna#End}.">
          <textarea className="input" style={{ fontFamily: "ui-monospace, monospace", minHeight: 70 }} value={String(settings.expression ?? "")} onChange={(e) => { set({ expression: e.target.value }); setPreview(null); }} placeholder='IF(DAYS({Cierre previsto}, TODAY()) < 0, "Vencido", "OK")' />
        </Field>
        <Field label="Resultado"><select className="input" value={String(settings.result ?? "auto")} onChange={(e) => set({ result: e.target.value })}><option value="auto">Automático</option><option value="number">Número (suma en el pie)</option><option value="text">Texto</option><option value="boolean">Sí / No</option><option value="date">Fecha</option></select></Field>
        <Field label="Probar"><button className="btn sm" type="button" onClick={async () => setPreview(await api.post("columns/formula/preview", { object, expression: String(settings.expression ?? "") }))}><FlaskConical />Vista previa con un registro</button>{preview && <div className={`small mt8 ${preview.error ? "" : "ok"}`} style={{ color: preview.error ? "var(--risk)" : undefined }}>{preview.error ? `Error: ${preview.error}` : `Resultado: ${String(preview.value ?? "(vacío)")}`}</div>}</Field>
        <Field label="Columnas" full><div className="row wrap" style={{ gap: 4 }}>{refs.map((r) => <button key={r} type="button" className="tag" onClick={() => ins(`{${r}}`)}>{r}</button>)}</div></Field>
        <Field label="Funciones" full><div className="col" style={{ gap: 4, maxHeight: 150, overflow: "auto" }}>{families.map((fam) => <div key={fam} className="row wrap" style={{ gap: 4 }}><b className="xs" style={{ width: 60 }}>{fam}</b>{Object.entries(fns).filter(([, f]) => f.family === fam).map(([k, f]) => <button key={k} type="button" className="tag" title={`${f.sig} · ${f.desc}`} onClick={() => ins(`${k}(`)}>{k}</button>)}</div>)}</div></Field>
      </>
    );
  }
  if (type === "mirror") {
    const rel = schema?.relations.find((r) => r.key === settings.relation);
    return (
      <>
        <Field label="Relación (connect)"><select className="input" value={String(settings.relation ?? "")} onChange={(e) => { const r = schema?.relations.find((x) => x.key === e.target.value); set({ relation: e.target.value, field: "", agg: r?.many ? "list" : "first" }); }}><option value="">— Elige —</option>{schema?.relations.map((r) => <option key={r.key} value={r.key}>{r.label}{r.many ? " (varios)" : ""}</option>)}</select></Field>
        <Field label="Columna a reflejar"><select className="input" value={String(settings.field ?? "")} onChange={(e) => set({ field: e.target.value })} disabled={!rel}><option value="">— Elige —</option>{rel?.fields.map((f) => <option key={f} value={f}>{f}</option>)}</select></Field>
        <Field label="Agregación"><select className="input" value={String(settings.agg ?? "list")} onChange={(e) => set({ agg: e.target.value })}>{Object.entries(AGG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {["all_eq", "any_eq", "none_eq", "pct_eq"].includes(String(settings.agg)) && <Field label="Valor a comparar"><input className="input" value={String(settings.compare ?? "")} onChange={(e) => set({ compare: e.target.value })} placeholder="ej. done, true, fulfilled" /></Field>}
        <p className="xs muted full">El resultado se puede usar como condición y como disparador: «cuando TODAS las tareas estén hechas…», «si la suma del pipeline &gt; 100.000…».</p>
      </>
    );
  }
  return null;
}
