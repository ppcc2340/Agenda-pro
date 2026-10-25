import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { api, ApiError } from "../api";
import { useApp, type CustomField, type LabelSet, type StatusLabel } from "../lib/app";
import { Modal, Field, useToast, useConfirm, errorMessage, TagInput, Spinner } from "../components/ui";
import { ColumnSettings, StatusLabelsEditor, TYPE_LABEL, TYPE_HELP, COMPUTED, AGG } from "../components/ColumnSettings";
import { FIELD_LABEL } from "../lib/format";

const OBJ: Record<string, string> = { contact: "Contactos", company: "Empresas", deal: "Negocios", ticket: "Tickets", contract: "Contratos" };
type Dep = { kind: string; id: string; name: string };
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/^[^a-z]/, "c$&");

function summary(f: CustomField): string {
  const s = (f.settings ?? {}) as Record<string, unknown>;
  if (f.type === "status") return ((s.labels as StatusLabel[] | undefined) ?? []).map((l) => l.label).join(", ");
  if (f.type === "formula") return String(s.expression ?? "");
  if (f.type === "mirror") return `${s.relation} · ${s.field} · ${AGG[String(s.agg)] ?? s.agg}${s.compare ? ` «${s.compare}»` : ""}`;
  if (f.type === "button") return `Botón «${s.label ?? f.label}»`;
  return f.options.join(", ");
}

export function CustomFieldsAdmin() {
  const { customFields, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<CustomField> | null>(null);
  const [obj, setObj] = useState<string>("");
  const [deps, setDeps] = useState<{ field: CustomField; items: Dep[] } | null>(null);
  const save = async () => { if (!editing) return; try { const body = { ...editing, options: editing.options ?? [], settings: editing.settings ?? {}, required: !!editing.required, show_if: editing.show_if?.field ? editing.show_if : null }; delete (body as Record<string, unknown>).id; if (editing.id) await api.put(`admin/custom-fields/${editing.id}`, { ...body, object: undefined, key: undefined }); else await api.post("admin/custom-fields", body); toast("Columna guardada", "ok"); setEditing(null); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async (f: CustomField, force = false) => {
    if (!force && !(await confirm({ title: `¿Borrar la columna ${f.label}?`, text: "Los valores guardados dejarán de mostrarse.", danger: true, confirmText: "Borrar" }))) return;
    try { await api.del(`admin/custom-fields/${f.id}${force ? "?force=1" : ""}`); setDeps(null); refresh(); toast("Columna borrada", "ok"); }
    catch (e) { if (e instanceof ApiError && e.status === 409) setDeps({ field: f, items: ((e.details as { dependents?: Dep[] })?.dependents) ?? [] }); else toast(errorMessage(e), "error"); }
  };
  const list = customFields.filter((f) => !obj || f.object === obj);
  return (
    <div className="card tight">
      <div className="row between wrap" style={{ padding: "12px 16px" }}>
        <div><h2>Columnas personalizadas</h2><p className="small muted">Cada celda guarda un valor (la verdad) y muestra un texto derivado. Los estados se guardan por ID de etiqueta; las fórmulas y reflejos se calculan por fila y sí pueden disparar automatizaciones.</p></div>
        <div className="row"><select className="input sm" style={{ width: "auto" }} value={obj} onChange={(e) => setObj(e.target.value)}><option value="">Todos los tableros</option>{Object.entries(OBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="btn primary sm" onClick={() => setEditing({ object: obj || "deal", type: "status", key: "", label: "", options: [], required: 0, settings: {} })}><Plus />Nueva columna</button></div>
      </div>
      <table className="table"><thead><tr><th>Tablero</th><th>Columna</th><th>Clave</th><th>Tipo</th><th>Configuración</th><th>Oblig.</th><th></th></tr></thead><tbody>
        {list.map((f) => <tr key={f.id}><td>{OBJ[f.object]}</td><td className="bold">{f.label}</td><td><code>{f.key}</code></td><td>{TYPE_LABEL[f.type] ?? f.type}{COMPUTED.includes(f.type) && <span className="badge" style={{ marginLeft: 6 }}>calculada</span>}</td><td className="small muted ell" style={{ maxWidth: 360 }} title={summary(f)}>{summary(f)}</td><td>{f.required ? "sí" : ""}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => setEditing({ ...f, settings: { ...(f.settings ?? {}) } })} aria-label="Editar"><Pencil size={15} /></button><button className="iconbtn" onClick={() => del(f)} aria-label="Borrar"><Trash2 size={15} /></button></td></tr>)}
        {list.length === 0 && <tr><td colSpan={7} className="muted">Sin columnas personalizadas.</td></tr>}
      </tbody></table>
      {editing && <Modal title={editing.id ? `Editar «${editing.label}»` : "Nueva columna"} size="lg" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
        <div className="form-grid">
          <Field label="Tablero"><select className="input" disabled={!!editing.id} value={editing.object} onChange={(e) => setEditing({ ...editing, object: e.target.value })}>{Object.entries(OBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Tipo" hint={TYPE_HELP[editing.type ?? ""]}><select className="input" value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value, settings: {} })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Nombre"><input className="input" value={editing.label ?? ""} onChange={(e) => setEditing({ ...editing, label: e.target.value, key: editing.id ? editing.key : slug(e.target.value) })} /></Field>
          <Field label="ID de columna" hint="Estable: no cambia al renombrar"><input className="input" disabled={!!editing.id} value={editing.key ?? ""} onChange={(e) => setEditing({ ...editing, key: e.target.value })} /></Field>
          {(editing.type === "select" || editing.type === "multiselect") && <Field label="Opciones" full><TagInput value={editing.options ?? []} onChange={(v) => setEditing({ ...editing, options: v })} placeholder="Escribe y pulsa Enter" /></Field>}
          <ColumnSettings object={editing.object ?? "deal"} type={editing.type ?? "text"} settings={(editing.settings ?? {}) as Record<string, unknown>} fieldKey={editing.key} onChange={(st) => setEditing({ ...editing, settings: st })} />
          {!COMPUTED.includes(editing.type ?? "") && editing.type !== "button" && <>
            <Field label="Sección en la ficha"><input className="input" value={editing.section ?? ""} onChange={(e) => setEditing({ ...editing, section: e.target.value })} /></Field>
            <Field label="Valor por defecto" hint={editing.type === "status" ? "Texto de la etiqueta" : undefined}><input className="input" value={editing.default_value ?? ""} onChange={(e) => setEditing({ ...editing, default_value: e.target.value })} /></Field>
            <Field label="Mostrar solo si (campo = valor)" full><div className="row"><input className="input" placeholder="campo" value={editing.show_if?.field ?? ""} onChange={(e) => setEditing({ ...editing, show_if: { field: e.target.value, value: editing.show_if?.value ?? "" } })} /><input className="input" placeholder="valor" value={editing.show_if?.value ?? ""} onChange={(e) => setEditing({ ...editing, show_if: { field: editing.show_if?.field ?? "", value: e.target.value } })} /></div></Field>
            <label className="checkbox full"><input type="checkbox" checked={!!editing.required} onChange={(e) => setEditing({ ...editing, required: e.target.checked ? 1 : 0 })} />Obligatoria siempre (para obligatoria solo en ciertos estados usa Reglas de tablero)</label>
          </>}
        </div>
      </Modal>}
      {deps && <Modal title={`«${deps.field.label}» está en uso`} onClose={() => setDeps(null)} footer={<><button className="btn" onClick={() => setDeps(null)}>Cancelar</button><button className="btn danger" onClick={() => del(deps.field, true)}>Borrar igualmente</button></>}>
        <p className="small"><AlertTriangle size={14} /> Antes de borrar, revisa estos elementos: dejarán de funcionar o devolverán vacío.</p>
        <ul className="small">{deps.items.map((d, i) => <li key={i}><b>{d.kind}</b>: {d.name}</li>)}</ul>
      </Modal>}
    </div>
  );
}

export function LabelSetsAdmin() {
  const { labelSets, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<LabelSet> | null>(null);
  const save = async () => { if (!editing) return; try { const body = { name: editing.name, labels: editing.labels ?? [] }; if (editing.id) await api.put(`columns/label-sets/${editing.id}`, body); else await api.post("columns/label-sets", body); toast("Conjunto guardado", "ok"); setEditing(null); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Etiquetas compartidas</h2><p className="small muted">Conjuntos de etiquetas de estado definidos una vez y usados en varios tableros, con los mismos textos, colores e IDs (como las «managed columns»). Una receta «cuando el estado cambia a Firmado» significa lo mismo en todos los tableros y los informes agregan sin mapeos.</p></div><button className="btn primary sm" onClick={() => setEditing({ name: "", labels: [{ id: 0, label: "Pendiente", color: "#c4c4c4" }, { id: 0, label: "En curso", color: "#fdab3d" }, { id: 0, label: "Hecho", color: "#00c875", done: true }] })}><Plus />Nuevo conjunto</button></div>
      <table className="table"><thead><tr><th>Conjunto</th><th>Etiquetas</th><th className="r">Columnas que lo usan</th><th></th></tr></thead><tbody>
        {labelSets.map((s) => <tr key={s.id}><td className="bold">{s.name}</td><td>{s.labels.map((l) => <span key={l.id} className="pill-inline" style={{ background: l.color }}>{l.label}</span>)}</td><td className="r num">{s.used_by ?? 0}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => setEditing({ ...s })} aria-label="Editar"><Pencil size={15} /></button><button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Borrar «${s.name}»?`, danger: true, confirmText: "Borrar" })) { try { await api.del(`columns/label-sets/${s.id}`); refresh(); } catch (e) { toast(errorMessage(e), "error"); } } }} aria-label="Borrar"><Trash2 size={15} /></button></td></tr>)}
        {labelSets.length === 0 && <tr><td colSpan={4} className="muted">Aún no hay conjuntos compartidos.</td></tr>}
      </tbody></table>
      {editing && <Modal title={editing.id ? "Editar conjunto" : "Nuevo conjunto"} onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={!editing.name?.trim()} onClick={save}>Guardar</button></>}>
        <Field label="Nombre"><input className="input" autoFocus value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Ej. Estado de firma" /></Field>
        <div className="mt12"><StatusLabelsEditor labels={editing.labels ?? []} onChange={(l) => setEditing({ ...editing, labels: l })} /></div>
      </Modal>}
    </div>
  );
}

type Rule = { when_field: string; values: string[]; fields: string[] };
export function BoardRulesAdmin() {
  const { customFields } = useApp();
  const toast = useToast();
  const [object, setObject] = useState("deal");
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  const [schema, setSchema] = useState<{ builtin: { id: string; title: string; type: string }[] } | null>(null);
  useEffect(() => { setCfg(null); api.get<{ config: Record<string, unknown> }>(`boards/${object}`).then((r) => setCfg(r.config ?? {})); api.get<{ builtin: { id: string; title: string; type: string }[] }>(`columns/schema/${object}`).then(setSchema); }, [object]);
  if (!cfg || !schema) return <Spinner />;
  const fields = [...schema.builtin.filter((b) => !["creation_log", "last_updated"].includes(b.type)).map((b) => ({ key: b.id, label: b.title })), ...customFields.filter((f) => f.object === object && !COMPUTED.includes(f.type) && f.type !== "button").map((f) => ({ key: `custom.${f.key}`, label: f.label }))];
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? FIELD_LABEL[k] ?? k;
  const defaults = (cfg.defaults ?? {}) as Record<string, string>;
  const required = (cfg.required ?? []) as Rule[];
  const save = async (next: Record<string, unknown>) => { try { await api.put(`boards/${object}`, next); setCfg(next); toast("Reglas del tablero guardadas", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="row between wrap mb12"><div><h2>Reglas del tablero</h2><p className="small muted">Valores por defecto (el elemento nace con ellos: no generan evento de cambio ni gastan acciones) y columnas obligatorias para pasar a ciertos estados.</p></div><select className="input sm" style={{ width: "auto" }} value={object} onChange={(e) => setObject(e.target.value)}>{Object.entries(OBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <h3 className="mb8">Valores por defecto</h3>
        <table className="table"><thead><tr><th>Columna</th><th>Valor al crear</th><th></th></tr></thead><tbody>
          {Object.entries(defaults).map(([k, v]) => <tr key={k}><td>{label(k)}</td><td><input className="input sm" defaultValue={v} onBlur={(e) => e.target.value !== v && save({ ...cfg, defaults: { ...defaults, [k]: e.target.value } })} /></td><td className="r"><button className="iconbtn" onClick={() => { const d = { ...defaults }; delete d[k]; save({ ...cfg, defaults: d }); }} aria-label="Quitar"><Trash2 size={14} /></button></td></tr>)}
        </tbody></table>
        <div className="row mt8"><select className="input sm" style={{ width: "auto" }} id="defField" defaultValue=""><option value="">Añadir columna…</option>{fields.filter((f) => !(f.key in defaults)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select><button className="btn sm" onClick={() => { const el = document.getElementById("defField") as HTMLSelectElement; if (el.value) save({ ...cfg, defaults: { ...defaults, [el.value]: "" } }); }}><Plus />Añadir</button><span className="xs muted">Usa @me para «quien lo crea» y @today para la fecha de hoy.</span></div>
      </div>
      <div className="card">
        <h3 className="mb8">Columnas obligatorias por estado</h3>
        {required.map((r, i) => (
          <div key={i} className="rule mb8">
            <div className="grow form-grid" style={{ padding: 0 }}>
              <Field label="Cuando la columna"><select className="input sm" value={r.when_field} onChange={(e) => save({ ...cfg, required: required.map((x, j) => (j === i ? { ...x, when_field: e.target.value } : x)) })}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></Field>
              <Field label="pase a (valores)" hint="Clave interna o ID de etiqueta"><TagInput value={r.values} onChange={(v) => save({ ...cfg, required: required.map((x, j) => (j === i ? { ...x, values: v } : x)) })} /></Field>
              <Field label="exigir que estén rellenas" full><div className="row wrap" style={{ gap: 6 }}>{fields.map((f) => <label key={f.key} className="checkbox xs"><input type="checkbox" checked={r.fields.includes(f.key)} onChange={(e) => save({ ...cfg, required: required.map((x, j) => (j === i ? { ...x, fields: e.target.checked ? [...x.fields, f.key] : x.fields.filter((y) => y !== f.key) } : x)) })} />{f.label}</label>)}</div></Field>
            </div>
            <button className="iconbtn" onClick={() => save({ ...cfg, required: required.filter((_, j) => j !== i) })} aria-label="Quitar regla"><Trash2 size={14} /></button>
          </div>
        ))}
        <button className="btn sm" onClick={() => save({ ...cfg, required: [...required, { when_field: object === "deal" ? "stage_id" : "status", values: [object === "ticket" ? "resolved" : object === "contract" ? "APPROVED" : "won"], fields: [fields[0]!.key] }] })}><Plus />Nueva regla</button>
        <p className="xs muted mt8">Si alguien (o una automatización) intenta pasar a ese estado sin los datos, el cambio se rechaza con el nombre de las columnas que faltan.</p>
      </div>
    </div>
  );
}
