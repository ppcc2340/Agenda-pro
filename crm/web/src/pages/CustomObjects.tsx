/**
 * Objetos personalizados (Proyectos, Inmuebles, Vehículos, Pedidos…): tablero tipo hoja de cálculo con kanban por estado,
 * ficha con campos, relaciones en los dos sentidos, notas, tareas e historial, y el constructor en Ajustes.
 */
import { useCallback, useEffect, useMemo, useState, Fragment, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus, Upload, Pencil, Trash2, MoreHorizontal, X, Search, StickyNote, CheckSquare, FolderKanban, Briefcase, Home, Car, Package, Wrench, Truck, Building, ClipboardList, Calendar, Star, Box, Flag, Layers, ShoppingCart, GraduationCap, HeartPulse, type LucideIcon } from "lucide-react";
import { api, qs } from "../api";
import { useApp, type ObjectDef, type ObjRelation, type ObjStatus } from "../lib/app";
import { useBoard, customColumns, PALETTE, type BoardObject } from "../lib/board";
import { DataTable, type Column, type GroupOption, type StatusOption } from "../components/DataTable";
import { CustomFieldsForm, formatCustom } from "../components/CustomFields";
import { HistoryList } from "./ContactDetail";
import { RecordAutomations } from "./AutomationCenter";
import { Modal, Field, Spinner, Empty, Menu, Seg, Tabs, useToast, useConfirm, errorMessage, useDebounce } from "../components/ui";
import { fmtDate, fmtDateTime, relTime } from "../lib/format";
import { pillStyle } from "../lib/colors";

type Rec = Record<string, unknown>;
type LinkItem = { id: string; name: string; object: string };
interface CRecord { id: string; name: string; number: string | null; status: string | null; owner_id: string | null; owner_name: string | null; tags: string[]; custom: Rec; links?: Record<string, LinkItem[]>; created_at: string; updated_at: string }

export const OBJECT_ICONS: Record<string, LucideIcon> = { folder: FolderKanban, briefcase: Briefcase, home: Home, car: Car, package: Package, wrench: Wrench, truck: Truck, building: Building, clipboard: ClipboardList, calendar: Calendar, star: Star, box: Box, flag: Flag, layers: Layers, cart: ShoppingCart, education: GraduationCap, health: HeartPulse };
export const ObjectIcon = ({ name, size = 16 }: { name: string; size?: number }) => { const I = OBJECT_ICONS[name] ?? FolderKanban; return <I size={size} />; };
/** Ruta de la ficha de cualquier objeto (nativo o personalizado). */
const CORE_PATH: Record<string, string> = { contact: "/contactos", company: "/empresas", deal: "/negocios", contract: "/contratos", ticket: "/tickets" };
const CORE_LABEL: Record<string, string> = { contact: "Contactos", company: "Empresas", deal: "Negocios", contract: "Contratos", ticket: "Tickets" };
export const recordPath = (object: string, id: string) => (CORE_PATH[object] ? `${CORE_PATH[object]}/${id}` : `/o/${object}/${id}`);

/** Definición del objeto: la del contexto o, si se acaba de crear, la del servidor. */
function useObjectDef(key: string | undefined) {
  const { objects } = useApp();
  const [fetched, setFetched] = useState<ObjectDef | null | undefined>(undefined);
  const fromCtx = objects.find((o) => o.key === key);
  useEffect(() => { if (!fromCtx && key) api.get<ObjectDef>(`objects/${key}`).then(setFetched).catch(() => setFetched(null)); }, [fromCtx, key]);
  return fromCtx ?? fetched;
}
const statusOpts = (def: ObjectDef): Record<string, StatusOption> => Object.fromEntries(def.statuses.map((s) => [String(s.id), { label: s.label, color: s.color }]));
const LinkChips = ({ items }: { items: LinkItem[] | undefined }) => (items?.length ? <span className="row wrap" style={{ gap: 3 }}>{items.map((l) => <Link key={l.id} to={recordPath(l.object, l.id)} className="tag" onClick={(e) => e.stopPropagation()}>{l.name}</Link>)}</span> : <span className="muted">—</span>);

/* ------------------------------------------------------------------ tablero */
export function CustomObjectPage() {
  const { key } = useParams();
  const def = useObjectDef(key);
  if (def === undefined) return <Spinner />;
  if (!def) return <Empty title="Este tablero no existe" text="Puede que se haya borrado o que tu rol no tenga acceso." action={<Link to="/" className="btn">Volver al inicio</Link>} />;
  return <ObjectBoard key={def.key} def={def} />;
}

function ObjectBoard({ def }: { def: ObjectDef }) {
  const nav = useNavigate();
  const { customFields, can, users, userName, refresh, isAdmin } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const key = def.key;
  const board = useBoard(key as BoardObject);
  const [view, setView] = useState<"table" | "kanban">(() => (localStorage.getItem(`crm:view:${key}`) as "table") || "table");
  const [importing, setImporting] = useState(false);
  const [rk, setRk] = useState(0);
  useEffect(() => { try { localStorage.setItem(`crm:view:${key}`, view); } catch { /* sin almacenamiento */ } }, [key, view]);
  const editable = can(key, "update");
  const patch = (r: CRecord, body: Rec) => api.patch(`records/${key}/${r.id}`, body).then(() => undefined);
  const saveStatuses = async (items: { key: string; label: string; color: string; done?: boolean; isNew?: boolean }[]) => {
    try { await api.put(`objects/${key}`, { statuses: items.map((it) => ({ id: it.isNew ? undefined : Number(it.key), label: it.label, color: it.color, done: !!it.done })) }); await refresh(); toast("Estados guardados", "ok"); }
    catch (e) { toast(errorMessage(e), "error"); }
  };
  const relCol = (rel: ObjRelation): Column<CRecord> => ({
    key: `links.${rel.key}`, label: rel.label, type: "relation", className: "l", sortable: false,
    field: editable ? `links.${rel.key}` : undefined,
    relation: { endpoint: `records/link-search/${rel.target}`, labelOf: (r) => String(r.name ?? "") },
    value: (r) => (r.links?.[rel.key] ?? []).map((l) => l.name).join(", ") || null,
    // en las relaciones de varios, elegir añade un vínculo en vez de sustituirlos
    onEdit: editable && rel.many ? (r, v) => patch(r, { links: { [rel.key]: v ? [...new Set([...(r.links?.[rel.key] ?? []).map((l) => l.id), String(v)])] : [] } }) : undefined,
    render: (r) => <LinkChips items={r.links?.[rel.key]} />,
  });
  const cols: Column<CRecord>[] = [
    { key: "name", label: def.primary_label, type: "name", field: editable ? "name" : undefined, sub: (r) => r.number, render: (r) => <Link to={`/o/${key}/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
    { key: "status", label: "Estado", sortable: true, type: "status", fixedOptions: true, field: editable ? "status" : undefined, options: statusOpts(def), value: (r) => r.status, onEdit: editable ? (r, v) => patch(r, { status: v == null ? null : String(v) }) : undefined, saveLabels: isAdmin ? (items) => saveStatuses(items) : undefined },
    ...(def.has_owner ? [{ key: "owner_name", label: "Propietario", type: "person", field: editable ? "owner_id" : undefined, onEdit: editable ? (r: CRecord, v: unknown) => patch(r, { owner_id: v }) : undefined } as Column<CRecord>] : []),
    ...(def.number_prefix ? [{ key: "number", label: "Número", sortable: true, default: false, readOnlyReason: "Numeración automática" } as Column<CRecord>] : []),
    ...def.relations.map(relCol),
    { key: "tags", label: "Etiquetas", type: "tags", default: false, field: editable ? "tags" : undefined },
    { key: "created_at", label: "Creado", sortable: true, type: "date", default: false, render: (r) => fmtDate(r.created_at) },
    { key: "updated_at", label: "Actualizado", sortable: true, default: false, className: "c", render: (r) => <span className="muted">{relTime(r.updated_at)}</span> },
    ...customColumns<CRecord>(customFields, key, board, editable ? (r, k, v) => patch(r, { custom: { [k]: v } }) : undefined, userName),
  ];
  const groupOptions: GroupOption<CRecord>[] = [
    { key: "status", label: "Estado", get: (r) => r.status ?? "", groups: def.statuses.map((s) => ({ key: String(s.id), label: s.label, color: s.color })), other: "Sin estado", setValue: (r, g) => patch(r, { status: g || null }), createValue: (g) => ({ status: g }) },
    ...(def.has_owner ? [{ key: "owner_id", label: "Propietario", get: (r: CRecord) => r.owner_id ?? "", groups: users.filter((u) => u.active).map((u) => ({ key: u.id, label: u.name, color: "var(--c-purple)" })), other: "Sin propietario", setValue: (r: CRecord, g: string) => patch(r, { owner_id: g || null }), createValue: (g: string) => ({ owner_id: g }) }] : []),
  ];
  const create = (name: string, extra: Rec) => api.post(`records/${key}`, { name, ...extra });
  const del = async (ids: string[]) => { if (await confirm({ title: `¿Borrar ${ids.length === 1 ? `este ${def.name.toLowerCase()}` : `${ids.length} ${def.plural.toLowerCase()}`}?`, text: "Se pueden restaurar desde la papelera del registro.", danger: true, confirmText: "Borrar" })) { await api.post(`records/${key}/bulk`, { ids, action: "delete" }); toast("Borrado", "ok"); setRk((x) => x + 1); } };
  return (
    <div>
      <div className="page-head">
        <div className="row"><span className="avatar lg" style={{ borderRadius: 10, background: def.color }}><ObjectIcon name={def.icon} size={20} /></span><div><h1>{def.plural}</h1>{def.description && <p className="sub">{def.description}</p>}</div></div>
        <div className="row">
          <Seg items={[{ key: "table", label: "Tabla" }, { key: "kanban", label: "Kanban" }]} value={view} onChange={setView} />
          {can(key, "create") && <button className="btn ghost" onClick={() => setImporting(true)}><Upload />Importar</button>}
          {isAdmin && <Link className="btn ghost" to={`/ajustes/objetos?edit=${key}`}><Pencil />Configurar</Link>}
        </div>
      </div>
      {view === "table" ? (
        <DataTable<CRecord> object={key as BoardObject} endpoint={`records/${key}`} columns={cols} board={board} groupOptions={groupOptions} refreshKey={rk}
          onCreate={can(key, "create") ? create : undefined} onRowClick={(r) => nav(`/o/${key}/${r.id}`)} exportUrl={can(key, "export") ? `records/${key}/export` : undefined}
          emptyText={`No hay ${def.plural.toLowerCase()}`} newLabel={`Nuevo ${def.name.toLowerCase()}`}
          onNew={can(key, "create") ? async () => { const name = prompt(`${def.primary_label} del nuevo ${def.name.toLowerCase()}`); if (!name?.trim()) return; try { const r = await create(name.trim(), {}) as { id: string }; nav(`/o/${key}/${r.id}`); } catch (e) { toast(errorMessage(e), "error"); } } : undefined}
          onDuplicate={can(key, "create") ? async (r) => { await api.post(`records/${key}`, { name: `${r.name} (copia)`, status: r.status, owner_id: r.owner_id, tags: r.tags, custom: r.custom, links: Object.fromEntries(Object.entries(r.links ?? {}).map(([k, v]) => [k, v.map((x) => x.id)])) }); setRk((x) => x + 1); } : undefined}
          onDelete={can(key, "delete") ? del : undefined}
          bulkActions={(ids, clear) => <>{def.statuses.length > 0 && editable && <select className="input sm" style={{ width: "auto" }} value="" onChange={async (e) => { if (!e.target.value) return; await api.post(`records/${key}/bulk`, { ids, action: "update", patch: { status: e.target.value } }); toast("Estado cambiado", "ok"); clear(); setRk((x) => x + 1); }} aria-label="Cambiar estado"><option value="">Cambiar estado…</option>{def.statuses.map((s) => <option key={s.id} value={String(s.id)}>{s.label}</option>)}</select>}{can(key, "delete") && <button className="btn sm danger" onClick={() => del(ids).then(clear)}>Borrar</button>}</>} />
      ) : <ObjectKanban def={def} refreshKey={rk} onChanged={() => setRk((x) => x + 1)} />}
      {importing && <ImportDialog def={def} onClose={() => setImporting(false)} onDone={() => setRk((x) => x + 1)} />}
    </div>
  );
}

function ObjectKanban({ def, refreshKey, onChanged }: { def: ObjectDef; refreshKey: number; onChanged: () => void }) {
  const [items, setItems] = useState<CRecord[] | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { can } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const load = useCallback(() => api.get<{ items: CRecord[] }>(`records/${def.key}${qs({ page_size: 500, sort: "updated_at", dir: "desc" })}`).then((r) => setItems(r.items)).catch((e) => toast(errorMessage(e), "error")), [def.key, toast]);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (!items) return <Spinner />;
  const editable = can(def.key, "update");
  const move = async (id: string, status: string) => {
    const prev = items; setItems(items.map((r) => (r.id === id ? { ...r, status } : r)));
    try { await api.patch(`records/${def.key}/${id}`, { status }); onChanged(); } catch (e) { setItems(prev); toast(errorMessage(e), "error"); }
  };
  const lanes: { key: string; label: string; color: string }[] = [...def.statuses.map((s) => ({ key: String(s.id), label: s.label, color: s.color })), ...(items.some((r) => !r.status) ? [{ key: "", label: "Sin estado", color: "#c4c4c4" }] : [])];
  return (
    <div className="kanban" aria-label={`Kanban de ${def.plural}`}>
      {lanes.map((l) => { const its = items.filter((r) => (r.status ?? "") === l.key); return (
        <div key={l.key || "none"} className={`kcol ${over === l.key ? "over" : ""}`} style={{ "--stage": l.color } as React.CSSProperties}
          onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(l.key); } }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id && l.key) move(id, l.key); }}>
          <div className="kcol-head"><div className="t"><span className="ell">{l.label}</span><span className="num">{its.length}</span></div></div>
          <div className="kcol-body">
            {its.map((r) => (
              <div key={r.id} className="kcard" draggable={editable} onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} onClick={() => nav(`/o/${def.key}/${r.id}`)} style={{ cursor: "pointer" }}>
                {r.number && <div className="c ell" style={{ color: def.color }}>{r.number}</div>}
                <div className="n ell" title={r.name}>{r.name}</div>
                {def.relations.filter((x) => (r.links?.[x.key] ?? []).length).slice(0, 2).map((x) => <div key={x.key} className="xs muted ell">{x.label}: {(r.links?.[x.key] ?? []).map((v) => v.name).join(", ")}</div>)}
                {r.owner_name && <div className="f"><span className="right avatar sm" title={r.owner_name}>{r.owner_name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</span></div>}
              </div>))}
            {its.length === 0 && <div className="muted small" style={{ textAlign: "center", padding: 12 }}>Vacío</div>}
          </div>
        </div>); })}
    </div>
  );
}

/** CSV mínimo: comillas, separador «,» o «;» (Excel en español) y saltos de línea dentro de comillas. */
function parseCsv(text: string): Rec[] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}
function ImportDialog({ def, onClose, onDone }: { def: ObjectDef; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Rec[]>([]);
  const [res, setRes] = useState<{ created: number; errors: { row: number; error: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { const r = await api.post<NonNullable<typeof res>>(`records/${def.key}/import`, { rows }); setRes(r); onDone(); toast(`${r.created} importados`, "ok"); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); } };
  return (
    <Modal title={`Importar ${def.plural.toLowerCase()}`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cerrar</button><button className="btn primary" disabled={!rows.length || busy || !!res} onClick={go}>Importar {rows.length || ""}</button></>}>
      <p className="small sub">CSV con cabecera. Columnas reconocidas: «{def.primary_label}» (o «nombre»), «estado», «propietario» (nombre o email) y cualquier columna personalizada por su nombre.</p>
      <input type="file" accept=".csv,text/csv" aria-label="Archivo CSV" className="input mt8" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setRes(null); setRows(parseCsv(await f.text())); } }} />
      {rows.length > 0 && !res && <p className="small mt8">{rows.length} filas · columnas: {Object.keys(rows[0]!).join(", ")}</p>}
      {res && <div className="mt8 small"><b>{res.created}</b> creados{res.errors.length ? `, ${res.errors.length} con errores:` : "."}{res.errors.slice(0, 10).map((e) => <div key={e.row} className="xs" style={{ color: "var(--risk)" }}>Fila {e.row}: {e.error}</div>)}</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ ficha */
interface Timeline { activities: { id: string; type: string; subject: string; body: string | null; occurred_at: string; user_name: string | null }[]; history: { id: string; action: string; changes: Record<string, unknown>; user_name: string | null; created_at: string }[]; tasks: { id: string; title: string; due_at: string | null; completed_at: string | null; assignee_name: string | null }[] }

export function CustomRecordPage() {
  const { key, id } = useParams();
  const def = useObjectDef(key);
  if (def === undefined) return <Spinner />;
  if (!def) return <Empty title="Este tablero no existe" action={<Link to="/" className="btn">Volver al inicio</Link>} />;
  return <RecordView key={`${def.key}:${id}`} def={def} id={id!} />;
}

function RecordView({ def, id }: { def: ObjectDef; id: string }) {
  const nav = useNavigate();
  const { customFields, users, userName, can } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [r, setR] = useState<CRecord | null>(null);
  const [tl, setTl] = useState<Timeline | null>(null);
  const [tab, setTab] = useState("timeline");
  const [note, setNote] = useState("");
  const [task, setTask] = useState({ title: "", due_at: "" });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const key = def.key;
  const editable = can(key, "update");
  const load = useCallback(() => api.get<CRecord>(`records/${key}/${id}`).then((x) => { setR(x); setName(x.name); }).catch((e) => { toast(errorMessage(e), "error"); nav(`/o/${key}`); }), [key, id, nav, toast]);
  const loadTl = useCallback(() => api.get<Timeline>(`records/${key}/${id}/timeline`).then(setTl).catch(() => undefined), [key, id]);
  useEffect(() => { load(); loadTl(); }, [load, loadTl]);
  if (!r) return <Spinner />;
  const patch = async (p: Rec) => { try { const x = await api.patch<CRecord>(`records/${key}/${id}`, p); setR(x); setName(x.name); loadTl(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!(await confirm({ title: `¿Borrar este ${def.name.toLowerCase()}?`, danger: true, confirmText: "Borrar" }))) return; await api.del(`records/${key}/${id}`); toast("Borrado", "ok"); nav(`/o/${key}`); };
  const addNote = async () => { if (!note.trim()) return; try { await api.post(`records/${key}/${id}/notes`, { body: note.trim() }); setNote(""); loadTl(); } catch (e) { toast(errorMessage(e), "error"); } };
  const addTask = async () => { if (!task.title.trim()) return; try { await api.post(`records/${key}/${id}/tasks`, { title: task.title.trim(), due_at: task.due_at ? new Date(`${task.due_at}T09:00:00`).toISOString() : null }); setTask({ title: "", due_at: "" }); loadTl(); setTab("tasks"); } catch (e) { toast(errorMessage(e), "error"); } };
  const st = def.statuses.find((s) => String(s.id) === String(r.status));
  const defs = customFields.filter((f) => f.object === key);
  return (
    <div>
      <div className="row small muted mb8"><Link to={`/o/${key}`}>{def.plural}</Link><span>/</span><span>{r.number ? `${r.number} · ` : ""}{r.name}</span></div>
      <div className="record">
        <aside className="side">
          <div className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span className="avatar lg" style={{ borderRadius: 10, background: def.color }}><ObjectIcon name={def.icon} size={22} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                {editable ? <input aria-label={def.primary_label} className="input bold" style={{ fontSize: 17 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== r.name && patch({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /> : <h1 style={{ fontSize: 18 }}>{r.name}</h1>}
                <div className="row wrap mt8" style={{ gap: 4 }}>{r.number && <span className="badge">{r.number}</span>}{st && <span className="badge" style={pillStyle(st.color)}>{st.label}</span>}</div>
              </div>
              <Menu trigger={<button className="iconbtn" aria-label="Más acciones"><MoreHorizontal size={18} /></button>}>{can(key, "delete") && <button className="danger" onClick={del}><Trash2 />Borrar</button>}</Menu>
            </div>
            <dl className="kv mt16">
              <dt>Estado</dt><dd><select aria-label="Estado" className="input sm" disabled={!editable} value={r.status ?? ""} onChange={(e) => patch({ status: e.target.value || null })}><option value="">—</option>{def.statuses.map((s) => <option key={s.id} value={String(s.id)}>{s.label}</option>)}</select></dd>
              {def.has_owner && <><dt>Propietario</dt><dd><select aria-label="Propietario" className="input sm" disabled={!editable} value={r.owner_id ?? ""} onChange={(e) => patch({ owner_id: e.target.value || null })}><option value="">Sin asignar</option>{users.filter((u) => u.active || u.id === r.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></dd></>}
              {def.relations.map((rel) => <Fragment key={rel.key}><dt>{rel.label}</dt><dd><LinksEditor rel={rel} value={r.links?.[rel.key] ?? []} editable={editable} onChange={(ids) => patch({ links: { [rel.key]: ids } })} /></dd></Fragment>)}
              {defs.map((f) => <Fragment key={f.id}><dt>{f.label}</dt><dd>{formatCustom(f, r.custom?.[f.key], (uid) => userName(uid)) || <span className="muted">—</span>}</dd></Fragment>)}
              <dt>Etiquetas</dt><dd className="row wrap" style={{ gap: 3 }}>{r.tags.length ? r.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">—</span>}</dd>
              <dt>Creado</dt><dd className="small">{fmtDate(r.created_at)}</dd>
            </dl>
            {editable && defs.length > 0 && <button className="btn sm mt12" style={{ width: "100%" }} onClick={() => setEditing(true)}><Pencil />Editar campos</button>}
          </div>
        </aside>
        <section>
          <div className="card">
            <textarea className="input" rows={3} aria-label="Nota" placeholder="Escribe una nota…" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row mt8"><button className="btn primary sm" disabled={!note.trim()} onClick={addNote}><StickyNote />Guardar nota</button><span className="grow" /><input aria-label="Nueva tarea" className="input sm" style={{ maxWidth: 240 }} placeholder="Nueva tarea…" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addTask()} /><input aria-label="Vencimiento" type="date" className="input sm" style={{ width: "auto" }} value={task.due_at} onChange={(e) => setTask({ ...task, due_at: e.target.value })} /><button className="btn sm" disabled={!task.title.trim()} onClick={addTask}><CheckSquare />Tarea</button></div>
          </div>
          <div className="mt16">
            <Tabs items={[{ key: "timeline", label: "Línea temporal", count: tl?.activities.length }, { key: "tasks", label: "Tareas", count: tl?.tasks.filter((t) => !t.completed_at).length }, { key: "related", label: "Relacionados" }, { key: "history", label: "Historial" }, { key: "auto", label: "Automatizaciones" }]} value={tab} onChange={setTab} />
            {tab === "timeline" && (!tl ? <Spinner /> : tl.activities.length === 0 ? <p className="muted">Sin notas todavía.</p> : <div className="col" style={{ gap: 8 }}>{tl.activities.map((a) => <div key={a.id} className="card tight" style={{ padding: 12 }}><div className="row xs muted"><b className="small" style={{ color: "var(--ink)" }}>{a.subject || "Nota"}</b><span className="grow" />{a.user_name} · {fmtDateTime(a.occurred_at)}</div>{a.body && <div className="small mt8" style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>}</div>)}</div>)}
            {tab === "tasks" && (!tl ? <Spinner /> : <div className="card tight"><table className="table"><thead><tr><th /><th>Tarea</th><th>Vence</th><th>Responsable</th></tr></thead><tbody>{tl.tasks.map((t) => <tr key={t.id} className={t.completed_at ? "muted" : ""}><td><input type="checkbox" aria-label="Completar" checked={!!t.completed_at} onChange={async () => { try { await api.post(`tasks/${t.id}/${t.completed_at ? "reopen" : "complete"}`, {}); loadTl(); } catch (e) { toast(errorMessage(e), "error"); } }} /></td><td style={{ textDecoration: t.completed_at ? "line-through" : undefined }}>{t.title}</td><td className="small">{t.due_at ? fmtDate(t.due_at) : "—"}</td><td className="small">{t.assignee_name}</td></tr>)}{tl.tasks.length === 0 && <tr><td colSpan={4} className="muted">Sin tareas.</td></tr>}</tbody></table></div>)}
            {tab === "related" && <RelatedCustomRecords object={key} id={id} empty={<p className="muted">Ningún otro objeto apunta a este {def.name.toLowerCase()}.</p>} />}
            {tab === "history" && <HistoryList items={tl?.history ?? null} />}
            {tab === "auto" && <RecordAutomations object={key} id={id} />}
          </div>
        </section>
      </div>
      {editing && <EditFields def={def} record={r} onClose={() => setEditing(false)} onSave={async (custom) => { await patch({ custom }); setEditing(false); }} />}
    </div>
  );
}

function EditFields({ def, record, onClose, onSave }: { def: ObjectDef; record: CRecord; onClose: () => void; onSave: (custom: Rec) => Promise<void> }) {
  const [v, setV] = useState<Rec>(record.custom ?? {});
  return <Modal title={`Editar ${def.name.toLowerCase()}`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave(v)}>Guardar</button></>}><div className="form-grid"><CustomFieldsForm object={def.key} value={v} onChange={setV} record={record as unknown as Rec} /></div></Modal>;
}

/** Vínculos de una relación: chips con quitar y buscador para añadir. */
function LinksEditor({ rel, value, editable, onChange }: { rel: ObjRelation; value: LinkItem[]; editable: boolean; onChange: (ids: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebounce(q, 150);
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { if (adding) api.get<{ items: { id: string; name: string }[] }>(`records/link-search/${rel.target}?q=${encodeURIComponent(dq)}`).then((r) => setItems(r.items)).catch(() => setItems([])); }, [adding, dq, rel.target]);
  const ids = value.map((x) => x.id);
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row wrap" style={{ gap: 3 }}>
        {value.map((l) => <span key={l.id} className="tag"><Link to={recordPath(l.object, l.id)}>{l.name}</Link>{editable && <button className="iconbtn" style={{ width: 16, height: 16 }} aria-label={`Quitar ${l.name}`} onClick={() => onChange(ids.filter((x) => x !== l.id))}><X size={11} /></button>}</span>)}
        {!value.length && !adding && <span className="muted">—</span>}
        {editable && !adding && (rel.many || !value.length) && <button className="btn xs ghost" onClick={() => setAdding(true)} aria-label={`Añadir ${rel.label}`}><Plus size={12} /></button>}
        {editable && !adding && !rel.many && value.length > 0 && <button className="btn xs ghost" onClick={() => setAdding(true)} aria-label={`Cambiar ${rel.label}`}><Pencil size={12} /></button>}
      </div>
      {adding && <div className="cpop" style={{ position: "static", padding: 6 }} onKeyDown={(e) => e.key === "Escape" && setAdding(false)}>
        <div className="row" style={{ gap: 4 }}><Search size={13} className="muted" /><input autoFocus className="input sm grow" aria-label={`Buscar ${rel.label}`} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="iconbtn" aria-label="Cerrar" onClick={() => setAdding(false)}><X size={13} /></button></div>
        <div className="col mt8" style={{ gap: 2, maxHeight: 180, overflow: "auto" }}>{items.filter((x) => !ids.includes(x.id)).map((x) => <button key={x.id} type="button" className="pick" onClick={() => { onChange(rel.many ? [...ids, x.id] : [x.id]); setAdding(false); setQ(""); }}>{x.name}</button>)}{items.length === 0 && <span className="xs muted">Sin resultados</span>}</div>
      </div>}
    </div>
  );
}

/* ------------------------------------------------------------------ panel de registros relacionados (lado inverso) */
type RelGroup = { object: string; name: string; plural: string; color: string; icon: string; relation: string; label: string; items: { id: string; name: string; number: string | null; status_label: ObjStatus | null; owner_name: string | null }[] };
/** Muestra, en la ficha de cualquier elemento, los registros de objetos personalizados que lo enlazan (p. ej. los Proyectos de una empresa). */
export function RelatedCustomRecords({ object, id, empty }: { object: string; id: string; empty?: ReactNode }) {
  const [groups, setGroups] = useState<RelGroup[] | null>(null);
  const { can } = useApp();
  const toast = useToast();
  const load = useCallback(() => api.get<{ groups: RelGroup[] }>(`records/related/${object}/${id}`).then((r) => setGroups(r.groups)).catch(() => setGroups([])), [object, id]);
  useEffect(() => { load(); }, [load]);
  if (!groups) return null;
  if (!groups.length) return <>{empty ?? null}</>;
  const add = async (g: RelGroup) => { const name = prompt(`${g.name}: nombre`); if (!name?.trim()) return; try { await api.post(`records/${g.object}`, { name: name.trim(), links: { [g.relation]: [id] } }); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  return <>{groups.map((g) => (
    <div key={`${g.object}:${g.relation}`} className="card" data-related={g.object}>
      <div className="card-title"><h3 className="row" style={{ gap: 6 }}><span className="sq" style={{ background: g.color, width: 10, height: 10, borderRadius: 3, display: "inline-block" }} />{g.label} <span className="muted small">{g.items.length}</span></h3>{can(g.object, "create") && <button className="btn xs" aria-label={`Nuevo ${g.name}`} onClick={() => add(g)}>+</button>}</div>
      {g.items.length === 0 ? <p className="muted small">Ninguno todavía.</p> : g.items.slice(0, 12).map((x) => <div key={x.id} className="row small" style={{ padding: "5px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/o/${g.object}/${x.id}`} className="grow ell">{x.number ? <span className="muted">{x.number} · </span> : null}{x.name}</Link>{x.status_label && <span className="badge" style={pillStyle(x.status_label.color)}>{x.status_label.label}</span>}</div>)}
      {g.items.length > 12 && <Link className="xs" to={`/o/${g.object}`}>Ver los {g.items.length}</Link>}
    </div>))}</>;
}

/* ------------------------------------------------------------------ constructor (Ajustes → Objetos personalizados) */
type Draft = { key?: string; name: string; plural: string; icon: string; color: string; primary_label: string; number_prefix: string; number_pad: number; has_owner: boolean; description: string; statuses: (Partial<ObjStatus> & { label: string; color: string })[]; relations: (Partial<ObjRelation> & { label: string; target: string; many: boolean })[] };
const EMPTY_DRAFT: Draft = { name: "", plural: "", icon: "folder", color: "#7c3aed", primary_label: "Nombre", number_prefix: "", number_pad: 4, has_owner: true, description: "", statuses: [{ label: "Nuevo", color: "#579bfc" }, { label: "En curso", color: "#fdab3d" }, { label: "Hecho", color: "#00c875", done: true }], relations: [] };

export function ObjectsAdmin() {
  const { objects, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<ObjectDef[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const load = useCallback(() => api.get<{ items: ObjectDef[] }>("objects").then((r) => setItems(r.items)), []);
  useEffect(() => { load(); }, [load]);
  // ?edit=o_x abre directamente el editor (botón «Configurar» del tablero)
  useEffect(() => { const k = new URLSearchParams(location.search).get("edit"); const d = items?.find((o) => o.key === k); if (d) setDraft(toDraft(d)); }, [items]);
  const toDraft = (d: ObjectDef): Draft => ({ key: d.key, name: d.name, plural: d.plural, icon: d.icon, color: d.color, primary_label: d.primary_label, number_prefix: d.number_prefix ?? "", number_pad: d.number_pad, has_owner: d.has_owner, description: d.description ?? "", statuses: d.statuses, relations: d.relations });
  const del = async (d: ObjectDef) => {
    if (!(await confirm({ title: `¿Borrar el objeto «${d.plural}»?`, text: d.records ? `Tiene ${d.records} registros: se borrarán con sus columnas y vínculos. No se puede deshacer.` : "Se borran también sus columnas personalizadas.", danger: true, confirmText: "Borrar" }))) return;
    try { await api.del(`objects/${d.key}${d.records ? "?force=1" : ""}`); toast("Objeto borrado", "ok"); load(); refresh(); } catch (e) { toast(errorMessage(e), "error"); }
  };
  const targets = useMemo(() => [...Object.entries(CORE_LABEL).map(([k, v]) => ({ key: k, label: v })), ...(items ?? objects).map((o) => ({ key: o.key, label: o.plural }))], [items, objects]);
  if (!items) return <Spinner />;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-title"><div><h2>Objetos personalizados</h2><p className="small sub">Crea tableros propios (Proyectos, Inmuebles, Vehículos, Pedidos…) con estados, numeración, propietario y relaciones con contactos, empresas, negocios, contratos, tickets u otros objetos. Tienen columnas personalizadas (fórmulas, reflejos, estados…), vistas, kanban, permisos por rol, automatizaciones e informes.</p></div><button className="btn primary" onClick={() => setDraft({ ...EMPTY_DRAFT, statuses: EMPTY_DRAFT.statuses.map((s) => ({ ...s })) })}><Plus />Nuevo objeto</button></div>
        {items.length === 0 ? <Empty title="Aún no hay objetos personalizados" text="Empieza por el que más uses fuera del CRM: proyectos, inmuebles, pedidos, activos…" /> : (
          <table className="table"><thead><tr><th>Objeto</th><th>Clave API</th><th>Estados</th><th>Relaciones</th><th className="r">Registros</th><th /></tr></thead><tbody>
            {items.map((d) => <tr key={d.key}><td><Link to={`/o/${d.key}`} className="row bold" style={{ gap: 8 }}><span className="avatar sm" style={{ borderRadius: 6, background: d.color }}><ObjectIcon name={d.icon} size={13} /></span>{d.plural}</Link></td><td><code className="xs">{d.key}</code></td><td className="small">{d.statuses.map((s) => <span key={s.id} className="badge" style={{ ...pillStyle(s.color), marginRight: 3 }}>{s.label}</span>)}</td><td className="small">{d.relations.map((r) => `${r.label} → ${targets.find((t) => t.key === r.target)?.label ?? r.target}${r.many ? " (varios)" : ""}`).join(" · ") || <span className="muted">—</span>}</td><td className="r num">{d.records ?? 0}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" aria-label={`Editar ${d.plural}`} onClick={() => setDraft(toDraft(d))}><Pencil size={15} /></button><button className="iconbtn" aria-label={`Borrar ${d.plural}`} onClick={() => del(d)}><Trash2 size={15} /></button></td></tr>)}
          </tbody></table>)}
      </div>
      {draft && <ObjectEditor draft={draft} targets={targets} onClose={() => setDraft(null)} onSaved={async (d) => { setDraft(null); await load(); await refresh(); toast(`«${d.plural}» guardado`, "ok"); }} />}
    </div>
  );
}

function ObjectEditor({ draft: initial, targets, onClose, onSaved }: { draft: Draft; targets: { key: string; label: string }[]; onClose: () => void; onSaved: (d: ObjectDef) => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setStatus = (i: number, p: Partial<Draft["statuses"][number]>) => set({ statuses: d.statuses.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setRel = (i: number, p: Partial<Draft["relations"][number]>) => set({ relations: d.relations.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const save = async () => {
    setBusy(true);
    const body = { name: d.name.trim(), plural: d.plural.trim(), icon: d.icon, color: d.color, primary_label: d.primary_label.trim() || "Nombre", number_prefix: d.number_prefix.trim() || null, number_pad: d.number_pad, has_owner: d.has_owner, description: d.description.trim() || null, statuses: d.statuses.filter((s) => s.label.trim()).map((s) => ({ id: s.id, label: s.label.trim(), color: s.color, done: !!s.done })), relations: d.relations.filter((r) => r.label.trim()).map((r) => ({ key: r.key, label: r.label.trim(), target: r.target, many: r.many, inverse_label: r.inverse_label?.trim() || undefined })) };
    try { const r = d.key ? await api.put<ObjectDef>(`objects/${d.key}`, body) : await api.post<ObjectDef>("objects", body); onSaved(r); }
    catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal size="lg" title={d.key ? `Configurar «${initial.plural}»` : "Nuevo objeto personalizado"} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !d.name.trim() || !d.plural.trim()} onClick={save}>{d.key ? "Guardar" : "Crear objeto"}</button></>}>
      <div className="form-grid">
        <Field label="Nombre en singular"><input className="input" value={d.name} placeholder="Proyecto" onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Nombre en plural" hint={d.key ? `Clave API: ${d.key}` : "Será el nombre del tablero"}><input className="input" value={d.plural} placeholder="Proyectos" onChange={(e) => set({ plural: e.target.value })} /></Field>
        <Field label="Campo principal"><input className="input" value={d.primary_label} placeholder="Nombre del proyecto" onChange={(e) => set({ primary_label: e.target.value })} /></Field>
        <Field label="Numeración" hint={d.number_prefix ? `Ej.: ${d.number_prefix}-${"1".padStart(d.number_pad, "0")}` : "Sin prefijo no se numera"}><div className="row"><input aria-label="Prefijo" className="input" style={{ width: 110 }} placeholder="PRJ" value={d.number_prefix} onChange={(e) => set({ number_prefix: e.target.value.toUpperCase() })} /><input aria-label="Dígitos" type="number" min={1} max={8} className="input" style={{ width: 80 }} value={d.number_pad} onChange={(e) => set({ number_pad: Math.max(1, Math.min(8, Number(e.target.value) || 4)) })} /></div></Field>
        <Field label="Icono"><div className="row wrap" style={{ gap: 4 }}>{Object.keys(OBJECT_ICONS).map((k) => <button key={k} type="button" className={`iconbtn ${d.icon === k ? "active" : ""}`} style={{ outline: d.icon === k ? "2px solid var(--sea)" : undefined }} aria-label={`Icono ${k}`} aria-pressed={d.icon === k} onClick={() => set({ icon: k })}><ObjectIcon name={k} /></button>)}</div></Field>
        <Field label="Color"><div className="row wrap" style={{ gap: 4 }}>{PALETTE.map((c) => <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={d.color === c} onClick={() => set({ color: c })} style={{ width: 22, height: 22, borderRadius: 5, background: c, border: 0, outline: d.color === c ? "2px solid var(--ink)" : undefined, outlineOffset: 1 }} />)}</div></Field>
        <label className="checkbox small"><input type="checkbox" checked={d.has_owner} onChange={(e) => set({ has_owner: e.target.checked })} />Tiene propietario (la visibilidad por rol «solo míos / mi equipo» se aplica sobre él)</label>
        <Field label="Descripción" full><input className="input" value={d.description} placeholder="Para qué sirve este tablero" onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Estados" full hint="Se guarda el ID de cada estado: renombrar no toca los datos. No se puede quitar un estado en uso.">
          <div className="col" style={{ gap: 4 }}>
            {d.statuses.map((s, i) => <div key={i} className="row" data-status-row>
              <input type="color" aria-label="Color del estado" value={s.color} onChange={(e) => setStatus(i, { color: e.target.value })} style={{ width: 34, height: 30, padding: 0, border: 0, background: "none" }} />
              <input className="input sm grow" aria-label="Nombre del estado" value={s.label} onChange={(e) => setStatus(i, { label: e.target.value })} />
              <label className="checkbox xs"><input type="checkbox" checked={!!s.done} onChange={(e) => setStatus(i, { done: e.target.checked })} />Cuenta como hecho</label>
              <button className="iconbtn" aria-label="Subir" disabled={i === 0} onClick={() => { const a = [...d.statuses]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; set({ statuses: a }); }}>↑</button>
              <button className="iconbtn" aria-label="Quitar estado" onClick={() => set({ statuses: d.statuses.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>)}
            <button className="btn xs ghost" style={{ alignSelf: "flex-start" }} onClick={() => set({ statuses: [...d.statuses, { label: "", color: PALETTE[(d.statuses.length * 3) % PALETTE.length]! }] })}><Plus size={12} />Añadir estado</button>
          </div>
        </Field>
        <Field label="Relaciones" full hint="«De uno» admite un único vínculo (p. ej. la empresa del proyecto); «varios» admite muchos. El otro lado verá la relación con el nombre inverso.">
          <div className="col" style={{ gap: 4 }}>
            {d.relations.map((r, i) => <div key={i} className="row wrap" data-relation-row>
              <input className="input sm" style={{ width: 150 }} aria-label="Nombre de la relación" placeholder="Empresa" value={r.label} onChange={(e) => setRel(i, { label: e.target.value })} />
              <span className="xs muted">con</span>
              <select className="input sm" style={{ width: "auto" }} aria-label="Objeto relacionado" value={r.target} disabled={!!r.key} onChange={(e) => setRel(i, { target: e.target.value })}>{targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}{!d.key && <option value="__self">Este mismo objeto</option>}</select>
              <select className="input sm" style={{ width: "auto" }} aria-label="Cardinalidad" value={r.many ? "many" : "one"} onChange={(e) => setRel(i, { many: e.target.value === "many" })}><option value="one">de uno</option><option value="many">varios</option></select>
              <input className="input sm" style={{ width: 160 }} aria-label="Nombre en el otro lado" placeholder={`En el otro lado: ${d.plural || "…"}`} value={r.inverse_label ?? ""} onChange={(e) => setRel(i, { inverse_label: e.target.value })} />
              {r.key && <code className="xs muted">links.{r.key}</code>}
              <button className="iconbtn" aria-label="Quitar relación" onClick={() => set({ relations: d.relations.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>)}
            <button className="btn xs ghost" style={{ alignSelf: "flex-start" }} onClick={() => set({ relations: [...d.relations, { label: "", target: "company", many: false }] })}><Plus size={12} />Añadir relación</button>
          </div>
        </Field>
        <p className="xs muted" style={{ gridColumn: "1 / -1" }}>Las columnas (texto, números, fechas, estados, fórmulas, reflejos, botones…) se añaden desde el propio tablero o en Ajustes → Columnas personalizadas. Los permisos por rol están en Ajustes → Roles y permisos.</p>
      </div>
    </Modal>
  );
}
