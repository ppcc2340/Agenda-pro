/**
 * Ajustes → Diseño de fichas (editor de secciones y campos por objeto y por rol, con vista previa en vivo) y
 * la matriz de seguridad por campo de Ajustes → Roles.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowUp, ArrowDown, Trash2, Plus, GripVertical, Settings2, ChevronDown, HelpCircle, Lock, RotateCcw, EyeOff } from "lucide-react";
import { api } from "../api";
import { Field, Spinner, useToast, useConfirm, errorMessage } from "../components/ui";
import { invalidateLayouts, BUILTIN_OPTIONS, type Layout, type LayoutField, type LayoutSection, type FieldInfo } from "../lib/layout";

const OBJECTS: Record<string, string> = { contact: "Contactos", company: "Empresas", deal: "Negocios", ticket: "Tickets", task: "Tareas", contract: "Contratos" };
type Role = { id: string; name: string; key: string; permissions: Record<string, unknown> };
type EditData = { layout: Layout; own: boolean; inherits: "default" | "generated" | null; catalog: FieldInfo[]; layouts: { id: string; role_id: string | null; role_name: string | null; updated_at: string }[] };
type Drag = { key: string; from: number | null; idx: number };

const slug = () => `s${Math.random().toString(36).slice(2, 8)}`;

export function LayoutsAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [object, setObject] = useState("contact");
  const [roleId, setRoleId] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [data, setData] = useState<EditData | null>(null);
  const [lay, setLay] = useState<Layout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [openField, setOpenField] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // el arrastre vive en una ref: cambiar el DOM durante dragstart cancela el arrastre en Chromium, así que el estilo llega después
  const dragRef = useRef<Drag | null>(null);
  const startDrag = (e: DragEvent, d: Drag) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.key); dragRef.current = d; setTimeout(() => setDrag(d), 0); };
  const endDrag = () => { dragRef.current = null; setDrag(null); };
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<{ items: Role[] }>("admin/roles").then((r) => setRoles(r.items)).catch(() => undefined); }, []);
  const load = () => api.get<EditData>(`layouts/${object}/edit${roleId ? `?role_id=${roleId}` : ""}`).then((d) => { setData(d); setLay(structuredClone(d.layout)); setDirty(false); setOpenField(null); }).catch((e) => toast(errorMessage(e), "error"));
  useEffect(() => { setData(null); load(); }, [object, roleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const info = useMemo(() => new Map((data?.catalog ?? []).map((f) => [f.key, f])), [data]);
  if (!data || !lay) return <Spinner />;
  const placed = new Set(lay.sections.flatMap((s) => s.fields.map((f) => f.key)));
  const free = data.catalog.filter((f) => !placed.has(f.key) && !["id", "workspace_id", "deleted_at"].includes(f.key));
  const label = (k: string) => info.get(k)?.label ?? k;

  const up = (fn: (l: Layout) => void) => { setLay((cur) => { const n = structuredClone(cur!); fn(n); return n; }); setDirty(true); };
  const setSec = (i: number, p: Partial<LayoutSection>) => up((l) => { Object.assign(l.sections[i]!, p); });
  const moveSec = (i: number, d: number) => up((l) => { const j = i + d; if (j < 0 || j >= l.sections.length) return; [l.sections[i], l.sections[j]] = [l.sections[j]!, l.sections[i]!]; });
  const delSec = (i: number) => up((l) => { l.sections.splice(i, 1); });
  const addSec = () => up((l) => { l.sections.push({ id: slug(), title: "Nueva sección", collapsed: false, columns: 1, fields: [] }); });
  const setFld = (si: number, fi: number, p: Partial<LayoutField>) => up((l) => { Object.assign(l.sections[si]!.fields[fi]!, p); });
  const moveFld = (si: number, fi: number, d: number) => up((l) => { const fs = l.sections[si]!.fields; const j = fi + d; if (j < 0 || j >= fs.length) return; [fs[fi], fs[j]] = [fs[j]!, fs[fi]!]; });
  const delFld = (si: number, fi: number) => up((l) => { l.sections[si]!.fields.splice(fi, 1); });
  const addFld = (key: string, si = lay.sections.length - 1) => up((l) => { if (!l.sections.length) l.sections.push({ id: slug(), title: "General", fields: [] }); l.sections[Math.max(0, si)]!.fields.push({ key }); });
  const toggleList = (list: "create" | "quick", key: string) => up((l) => { const cur = l[list]; l[list] = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]; });

  /** Soltar un campo (de la paleta o de otra sección) delante de la posición idx de la sección si. */
  const drop = (e: DragEvent, si: number, idx: number) => {
    e.preventDefault(); e.stopPropagation();
    const d = dragRef.current; if (!d) return;
    endDrag();
    up((l) => {
      let at = idx;
      if (d.from !== null) { const src = l.sections[d.from]!.fields; const [f] = src.splice(d.idx, 1); if (d.from === si && d.idx < idx) at -= 1; l.sections[si]!.fields.splice(at, 0, f!); }
      else l.sections[si]!.fields.splice(at, 0, { key: d.key });
    });
  };
  const allow = (e: DragEvent) => { if (dragRef.current) e.preventDefault(); };

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`layouts/${object}`, { role_id: roleId || null, config: lay });
      invalidateLayouts(); window.dispatchEvent(new Event("crm:layouts"));
      toast("Diseño guardado", "ok"); load();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!(await confirm({ title: roleId ? "¿Quitar el diseño propio de este rol?" : "¿Volver al diseño generado?", text: roleId ? "El rol volverá a usar el diseño general." : "Se borrará el diseño general guardado; los roles sin diseño propio verán el generado automáticamente.", confirmText: "Restablecer", danger: true }))) return;
    try { await api.del(`layouts/${object}${roleId ? `?role_id=${roleId}` : ""}`); invalidateLayouts(); window.dispatchEvent(new Event("crm:layouts")); toast("Diseño restablecido", "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); }
  };
  const roleName = roles.find((r) => r.id === roleId)?.name;
  const origin = data.own ? (roleId ? `Diseño propio de «${roleName}»` : "Diseño general guardado") : data.inherits === "default" ? "Heredado del diseño general" : "Generado automáticamente (aún sin personalizar)";

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <div className="row between wrap" style={{ gap: 8 }}>
          <div><h2>Diseño de fichas</h2><p className="small muted">Ordena secciones y campos de cada ficha, decide qué se pide al crear y qué se ve en la vista rápida. Cada rol puede tener su propio diseño; si no, usa el general.</p></div>
          <div className="row" style={{ gap: 6 }}><button className="btn" onClick={reset} disabled={!data.own}><RotateCcw size={14} />Restablecer</button><button className="btn primary" onClick={save} disabled={busy || !dirty}>Guardar diseño</button></div>
        </div>
        <div className="row wrap mt12" style={{ gap: 8, alignItems: "flex-end" }}>
          <div className="seg" role="tablist" aria-label="Objeto">{Object.entries(OBJECTS).map(([k, v]) => <button key={k} role="tab" aria-selected={object === k} className={object === k ? "active" : ""} onClick={() => setObject(k)}>{v}</button>)}</div>
          <Field label="Para"><select className="input" aria-label="Rol del diseño" value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">General (todos los roles)</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}{data.layouts.some((l) => l.role_id === r.id) ? " · propio" : ""}</option>)}</select></Field>
          <span className="badge">{origin}</span>
          {dirty && <span className="small" style={{ color: "var(--warn, #b45309)" }}>Cambios sin guardar</span>}
        </div>
      </div>

      <div className="lay-admin">
        <div className="col" style={{ gap: 10, minWidth: 0 }}>
          {lay.sections.map((s, si) => (
            <div key={s.id} className="card tight lay-ed-sec" onDragOver={allow} onDrop={(e) => drop(e, si, s.fields.length)}>
              <div className="row wrap lay-ed-sec-h" style={{ gap: 6 }}>
                <input className="input sm grow" aria-label="Título de la sección" value={s.title} onChange={(e) => setSec(si, { title: e.target.value })} />
                <label className="checkbox small"><input type="checkbox" checked={!!s.collapsed} onChange={(e) => setSec(si, { collapsed: e.target.checked })} />Plegada</label>
                <select className="input sm" aria-label="Columnas" value={s.columns ?? 1} onChange={(e) => setSec(si, { columns: Number(e.target.value) as 1 | 2 })}><option value={1}>1 columna</option><option value={2}>2 columnas</option></select>
                <button className="iconbtn" aria-label="Subir sección" disabled={si === 0} onClick={() => moveSec(si, -1)}><ArrowUp size={14} /></button>
                <button className="iconbtn" aria-label="Bajar sección" disabled={si === lay.sections.length - 1} onClick={() => moveSec(si, 1)}><ArrowDown size={14} /></button>
                <button className="iconbtn" aria-label="Borrar sección" onClick={() => delSec(si)}><Trash2 size={14} /></button>
              </div>
              {!s.fields.length && <p className="xs muted lay-drop">Arrastra campos aquí</p>}
              {s.fields.map((f, fi) => {
                const fi_ = info.get(f.key); const isOpen = openField === `${si}:${f.key}`;
                return (
                  <div key={f.key} className={`lay-ed-f ${drag?.key === f.key ? "dragging" : ""}`} draggable onDragStart={(e) => startDrag(e, { key: f.key, from: si, idx: fi })} onDragEnd={endDrag} onDragOver={allow} onDrop={(e) => drop(e, si, fi)}>
                    <div className="row" style={{ gap: 6 }}>
                      <GripVertical size={14} className="muted lay-grip" aria-hidden />
                      <span className="grow small"><b>{label(f.key)}</b> <span className="xs muted">{fi_?.builtin ? "" : "personalizado"}{fi_?.access === "hidden" ? " · oculto" : ""}</span>{f.required && <span className="badge" style={{ marginLeft: 6 }}>obligatorio</span>}{f.show_if && <span className="badge" style={{ marginLeft: 4 }}>condicional</span>}</span>
                      <button className="iconbtn" aria-label={`Ajustes de ${label(f.key)}`} aria-expanded={isOpen} onClick={() => setOpenField(isOpen ? null : `${si}:${f.key}`)}><Settings2 size={14} /></button>
                      <button className="iconbtn" aria-label="Subir campo" disabled={fi === 0} onClick={() => moveFld(si, fi, -1)}><ArrowUp size={13} /></button>
                      <button className="iconbtn" aria-label="Bajar campo" disabled={fi === s.fields.length - 1} onClick={() => moveFld(si, fi, 1)}><ArrowDown size={13} /></button>
                      <button className="iconbtn" aria-label={`Quitar ${label(f.key)}`} onClick={() => delFld(si, fi)}><Trash2 size={13} /></button>
                    </div>
                    {isOpen && <FieldSettings f={f} fi={fi_} catalog={data.catalog} onChange={(p) => setFld(si, fi, p)} />}
                  </div>
                );
              })}
            </div>
          ))}
          <button className="btn" onClick={addSec}><Plus size={14} />Añadir sección</button>

          <div className="card tight">
            <div style={{ padding: "10px 12px" }}>
              <b className="small">Formulario de alta y vista rápida</b>
              <p className="xs muted">«Alta»: campos que se piden al crear (además del nombre). «Rápida»: lo que se ve al pasar por encima de un registro (máx. 12).</p>
            </div>
            <table className="table"><thead><tr><th>Campo</th><th>Alta</th><th>Rápida</th></tr></thead><tbody>
              {data.catalog.filter((f) => f.access !== "hidden").map((f) => <tr key={f.key}><td className="small">{f.label}</td><td><input type="checkbox" aria-label={`${f.label} en el alta`} checked={lay.create.includes(f.key)} onChange={() => toggleList("create", f.key)} /></td><td><input type="checkbox" aria-label={`${f.label} en la vista rápida`} checked={lay.quick.includes(f.key)} disabled={!lay.quick.includes(f.key) && lay.quick.length >= 12} onChange={() => toggleList("quick", f.key)} /></td></tr>)}
            </tbody></table>
            <label className="checkbox small" style={{ padding: "8px 12px" }}><input type="checkbox" checked={lay.include_new !== false} onChange={(e) => up((l) => { l.include_new = e.target.checked; })} />Añadir automáticamente las columnas nuevas al final</label>
          </div>
        </div>

        <div className="col" style={{ gap: 10, minWidth: 0 }}>
          <div className="card tight lay-palette" onDragOver={allow} onDrop={(e) => { e.preventDefault(); const d = dragRef.current; endDrag(); if (d && d.from !== null) delFld(d.from, d.idx); }}>
            <div style={{ padding: "10px 12px" }}><b className="small">Campos disponibles</b><p className="xs muted">Arrástralos a una sección (o pulsa +). Suelta aquí un campo para quitarlo de la ficha.</p></div>
            <div className="row wrap" style={{ gap: 4, padding: "0 12px 12px" }}>
              {!free.length && <span className="xs muted">Todos los campos están en la ficha.</span>}
              {free.map((f) => <span key={f.key} className="tag lay-chip" draggable onDragStart={(e) => startDrag(e, { key: f.key, from: null, idx: -1 })} onDragEnd={endDrag}>{f.label}<button className="iconbtn xs" aria-label={`Añadir ${f.label}`} onClick={() => addFld(f.key)}><Plus size={11} /></button></span>)}
            </div>
          </div>
          <div className="card tight">
            <div style={{ padding: "10px 12px" }}><b className="small">Vista previa</b> <span className="xs muted">· así verá la ficha {roleId ? `el rol «${roleName}»` : "cualquier rol sin diseño propio"}</span></div>
            <LayoutPreview layout={lay} info={info} />
            <div style={{ padding: "10px 12px", borderTop: "1px solid var(--rule2)" }}>
              <b className="xs muted">FORMULARIO DE ALTA</b>
              <div className="row wrap mt4" style={{ gap: 4 }}>{lay.create.length ? lay.create.map((k) => { const req = lay.sections.some((s) => s.fields.some((f) => f.key === k && f.required)); return <span key={k} className="tag">{label(k)}{req ? " *" : ""}</span>; }) : <span className="xs muted">Solo el nombre</span>}</div>
              <b className="xs muted" style={{ display: "block", marginTop: 8 }}>VISTA RÁPIDA</b>
              <div className="row wrap mt4" style={{ gap: 4 }}>{lay.quick.length ? lay.quick.map((k) => <span key={k} className="tag">{label(k)}</span>) : <span className="xs muted">Vacía</span>}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Ajustes de un campo dentro de la ficha: obligatorio al crear, ayuda, valor por defecto y condición. */
function FieldSettings({ f, fi, catalog, onChange }: { f: LayoutField; fi?: FieldInfo; catalog: FieldInfo[]; onChange: (p: Partial<LayoutField>) => void }) {
  const opts = fi?.options_ref ? BUILTIN_OPTIONS[fi.options_ref] : undefined;
  const cond = f.show_if ?? null;
  const condOpts = cond ? BUILTIN_OPTIONS[catalog.find((c) => c.key === cond.field)?.options_ref ?? ""] : undefined;
  const dv = f.default === undefined || f.default === null ? "" : String(f.default);
  const setDefault = (v: string) => onChange({ default: v === "" ? null : fi?.type === "number" ? Number(v) : fi?.type === "boolean" ? v === "true" : v });
  return (
    <div className="form-grid lay-ed-cfg">
      <label className="checkbox small full"><input type="checkbox" checked={!!f.required} onChange={(e) => onChange({ required: e.target.checked })} />Obligatorio (al crear, si está en el alta, y al editar desde la ficha)</label>
      <Field label="Texto de ayuda" full><input className="input sm" value={f.help ?? ""} maxLength={300} onChange={(e) => onChange({ help: e.target.value || null })} placeholder="Se muestra junto a la etiqueta" /></Field>
      <Field label="Valor por defecto">
        {opts ? <select className="input sm" value={dv} onChange={(e) => setDefault(e.target.value)}><option value="">—</option>{Object.entries(opts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          : fi?.type === "boolean" ? <select className="input sm" value={dv} onChange={(e) => setDefault(e.target.value)}><option value="">—</option><option value="true">Sí</option><option value="false">No</option></select>
          : <input className="input sm" type={fi?.type === "number" ? "number" : fi?.type === "date" ? "date" : "text"} value={dv} onChange={(e) => setDefault(e.target.value)} />}
      </Field>
      <Field label="Mostrar solo si">
        <select className="input sm" value={cond?.field ?? ""} onChange={(e) => onChange({ show_if: e.target.value ? { field: e.target.value, op: cond?.op ?? "eq", value: null } : null })}><option value="">Siempre</option>{catalog.filter((c) => c.key !== f.key).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
      </Field>
      {cond && <>
        <Field label="Condición"><select className="input sm" value={cond.op ?? "eq"} onChange={(e) => onChange({ show_if: { ...cond, op: e.target.value as "eq" } })}><option value="eq">es igual a</option><option value="ne">es distinto de</option><option value="not_empty">tiene valor</option><option value="empty">está vacío</option></select></Field>
        {(cond.op ?? "eq") !== "empty" && cond.op !== "not_empty" && <Field label="Valor">{condOpts ? <select className="input sm" value={cond.value ?? ""} onChange={(e) => onChange({ show_if: { ...cond, value: e.target.value } })}><option value="">—</option>{Object.entries(condOpts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : <input className="input sm" value={cond.value ?? ""} onChange={(e) => onChange({ show_if: { ...cond, value: e.target.value } })} />}</Field>}
      </>}
    </div>
  );
}

/** Vista previa de la ficha tal y como la dibuja LayoutPanel, con valores de ejemplo. */
function LayoutPreview({ layout, info }: { layout: Layout; info: Map<string, FieldInfo> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="lay-panel" style={{ padding: "0 12px 12px" }} aria-label="Vista previa de la ficha">
      {!layout.sections.length && <p className="small muted">La ficha está vacía.</p>}
      {layout.sections.map((s) => {
        const isOpen = open[s.id] ?? !s.collapsed;
        return (
          <div key={s.id} className="lay-sec">
            <button type="button" className="lay-sec-h" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !isOpen }))}><ChevronDown size={14} style={{ transform: isOpen ? "none" : "rotate(-90deg)" }} />{s.title || "Sin título"}<span className="xs muted">{s.fields.length}</span></button>
            {isOpen && <dl className={`kv lay-kv ${s.columns === 2 ? "two" : ""}`}>
              {s.fields.map((f) => { const fi = info.get(f.key); return <div key={f.key} style={{ display: "contents" }}><dt>{fi?.label ?? f.key}{f.required ? " *" : ""}{f.help && <span title={f.help} className="lay-help"><HelpCircle size={11} /></span>}{fi?.access === "read" && <Lock size={10} className="muted" />}{fi?.access === "hidden" && <EyeOff size={10} className="muted" />}</dt><dd className="muted small">{f.show_if ? <i>si {info.get(f.show_if.field)?.label ?? f.show_if.field} {({ eq: "=", ne: "≠", empty: "vacío", not_empty: "con valor" } as Record<string, string>)[f.show_if.op ?? "eq"]} {f.show_if.value ?? ""}</i> : f.default !== undefined && f.default !== null && f.default !== "" ? `${String(f.default)} (por defecto)` : "—"}</dd></div>; })}
            </dl>}
          </div>
        );
      })}
    </div>
  );
}

/** Ajustes → Roles: qué campos puede editar, solo ver o no ver cada rol (el administrador siempre lo ve todo). */
export function FieldSecurityMatrix({ roles }: { roles: Role[] }) {
  const toast = useToast();
  const editable = roles.filter((r) => !r.permissions.admin);
  const [roleId, setRoleId] = useState(editable[0]?.id ?? "");
  const [object, setObject] = useState("contact");
  const [data, setData] = useState<{ objects: { object: string; fields: FieldInfo[]; access: Record<string, "read" | "hidden"> }[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, "edit" | "read" | "hidden">>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!roleId) return; api.get<typeof data>(`field-permissions?role_id=${roleId}`).then((d) => { setData(d); setDraft({}); }).catch((e) => toast(errorMessage(e), "error")); }, [roleId]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = data?.objects.find((o) => o.object === object);
  const valueOf = (k: string) => draft[k] ?? cur?.access[k] ?? "edit";
  const save = async () => {
    setBusy(true);
    try { await api.put("field-permissions", { role_id: roleId, object, fields: draft }); toast("Seguridad por campo guardada", "ok"); const d = await api.get<typeof data>(`field-permissions?role_id=${roleId}`); setData(d); setDraft({}); }
    catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  if (!editable.length) return null;
  const counts = cur ? cur.fields.reduce((a, f) => { a[valueOf(f.key)] = (a[valueOf(f.key)] ?? 0) + 1; return a; }, {} as Record<string, number>) : {};
  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid var(--rule2)" }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <div><b className="small">Seguridad por campo</b><p className="xs muted">Por rol y objeto: «editar», «solo ver» (aparece con candado) u «oculto» (no llega ni a listas, fichas, exportaciones, búsquedas ni informes). El administrador siempre tiene acceso completo.</p></div>
        <button className="btn primary sm" disabled={busy || !Object.keys(draft).length} onClick={save}>Guardar campos</button>
      </div>
      <div className="row wrap mt8" style={{ gap: 8, alignItems: "flex-end" }}>
        <Field label="Rol"><select className="input sm" aria-label="Rol para la seguridad por campo" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{editable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <div className="seg" role="tablist" aria-label="Objeto">{Object.entries(OBJECTS).map(([k, v]) => <button key={k} role="tab" aria-selected={object === k} className={object === k ? "active" : ""} onClick={() => { setObject(k); setDraft({}); }}>{v}</button>)}</div>
        {cur && <span className="xs muted">{counts.edit ?? 0} editables · {counts.read ?? 0} solo ver · {counts.hidden ?? 0} ocultos</span>}
      </div>
      {!cur ? <Spinner /> : (
        <table className="table mt8 lay-fsm"><thead><tr><th>Campo</th><th>Editar</th><th>Solo ver</th><th>Oculto</th></tr></thead><tbody>
          {cur.fields.map((f) => (
            <tr key={f.key} className={draft[f.key] ? "changed" : ""}>
              <td className="small">{f.label} {!f.builtin && <span className="xs muted">personalizado</span>}{f.locked && <span className="xs muted"> · siempre visible</span>}</td>
              {(["edit", "read", "hidden"] as const).map((a) => <td key={a}><input type="radio" name={`fs-${f.key}`} aria-label={`${f.label}: ${a === "edit" ? "editar" : a === "read" ? "solo ver" : "oculto"}`} disabled={!!f.locked && a !== "edit"} checked={valueOf(f.key) === a} onChange={() => setDraft((d) => ({ ...d, [f.key]: a }))} /></td>)}
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
