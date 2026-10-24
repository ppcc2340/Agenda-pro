import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Filter, Download, Columns3, Save, ChevronUp, ChevronDown, X, Bookmark, ChevronDown as Caret, Plus, Trash2 } from "lucide-react";
import { api, qs, downloadFile } from "../api";
import { FilterBuilder, describeFilters, type FilterGroup } from "./FilterBuilder";
import { Modal, Pager, Spinner, Empty, Field, useToast, useDebounce, errorMessage, Menu, Avatar } from "./ui";
import { useApp } from "../lib/app";
import { fmtMoney, fmtDate, fmtNum } from "../lib/format";

export type ColumnType = "text" | "name" | "status" | "person" | "money" | "number" | "date" | "tags";
export interface StatusOption { label: string; color: string }
export interface Column<T> {
  key: string; label: string; render?: (row: T) => ReactNode; sortable?: boolean; className?: string; default?: boolean; width?: number;
  /** monday-style cell type: drives rendering, summary row and inline editing */
  type?: ColumnType;
  /** for `status`: value → label/color */
  options?: Record<string, StatusOption>;
  /** raw value getter (defaults to row[key]) */
  value?: (row: T) => unknown;
  /** when present the cell is editable inline; receives the new raw value */
  onEdit?: (row: T, value: unknown) => Promise<void> | void;
  /** summary row aggregation for number/money (default sum) */
  agg?: "sum" | "avg" | "none";
  /** sub-text for `name` cells */
  sub?: (row: T) => ReactNode;
}
export interface Group { key: string; label: string; color: string }
export interface GroupBy<T> { get: (row: T) => string; groups: Group[]; /** label for rows that fit no group */ other?: string }
export interface SavedView { id: string; object: string; name: string; filters: FilterGroup; columns: string[]; sort: { field?: string; dir?: string }; shared: number; user_id: string }

interface Props<T> {
  object: "contact" | "company" | "deal" | "ticket";
  endpoint: string;
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  bulkActions?: (ids: string[], clear: () => void) => ReactNode;
  exportUrl?: string;
  extraParams?: Record<string, unknown>;
  refreshKey?: number;
  emptyText?: string;
  defaultSort?: { field: string; dir: "asc" | "desc" };
  groupBy?: GroupBy<T>;
  onNew?: () => void;
  newLabel?: string;
  onDelete?: (ids: string[]) => Promise<void> | void;
}

const EMPTY: FilterGroup = { logic: "and", conditions: [] };
const getPath = (row: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);

export function DataTable<T extends { id: string }>({ object, endpoint, columns, onRowClick, toolbar, bulkActions, exportUrl, extraParams, refreshKey, emptyText, defaultSort, groupBy, onNew, newLabel, onDelete }: Props<T>) {
  const { me } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const storageKey = `crm:cols:${object}`;
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounce(q, 250);
  const [filters, setFilters] = useState<FilterGroup>(() => { try { return params.get("filters") ? JSON.parse(params.get("filters")!) : EMPTY; } catch { return EMPTY; } });
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>(defaultSort ?? { field: "updated_at", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [saveView, setSaveView] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState<string | null>(params.get("view"));
  const [visible, setVisible] = useState<string[]>(() => { try { const s = localStorage.getItem(storageKey); if (s) return JSON.parse(s); } catch { /* ignore */ } return columns.filter((c) => c.default !== false).map((c) => c.key); });
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadViews = () => api.get<{ items: SavedView[] }>(`views?object=${object}`).then((r) => setViews(r.items)).catch(() => undefined);
  useEffect(() => { loadViews(); /* eslint-disable-next-line */ }, [object]);
  useEffect(() => { if (viewId && views.length) { const v = views.find((x) => x.id === viewId); if (v) { setFilters(v.filters?.conditions ? v.filters : EMPTY); if (v.columns?.length) setVisible(v.columns); if (v.sort?.field) setSort({ field: v.sort.field, dir: (v.sort.dir as "asc") ?? "desc" }); } } /* eslint-disable-next-line */ }, [viewId, views.length]);
  useEffect(() => { setPage(1); }, [dq, filters, sort]);
  const load = (silent = false) => {
    if (!silent) setLoading(true);
    return api.get<{ items: T[]; total: number }>(`${endpoint}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, page, page_size: pageSize, ...(extraParams ?? {}) })}`)
      .then((r) => { setData(r); if (!silent) setSel([]); })
      .catch((e) => toast(errorMessage(e), "error"))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    const p = new URLSearchParams(params);
    if (dq) p.set("q", dq); else p.delete("q");
    if (filters.conditions.length) p.set("filters", JSON.stringify(filters)); else p.delete("filters");
    if (viewId) p.set("view", viewId); else p.delete("view");
    setParams(p, { replace: true });
    load();
    /* eslint-disable-next-line */
  }, [dq, filters, sort, page, pageSize, endpoint, refreshKey, tick, JSON.stringify(extraParams)]);

  const cols = useMemo(() => columns.filter((c) => visible.includes(c.key)), [columns, visible]);
  const toggleSort = (c: Column<T>) => { if (!c.sortable) return; setSort((s) => ({ field: c.key, dir: s.field === c.key && s.dir === "desc" ? "asc" : "desc" })); };
  const saveCols = (v: string[]) => { setVisible(v); localStorage.setItem(storageKey, JSON.stringify(v)); };
  const applyView = (v: SavedView | null) => { setViewId(v?.id ?? null); if (!v) { setFilters(EMPTY); } };
  const deleteView = async (v: SavedView) => { await api.del(`views/${v.id}`); toast("Vista borrada", "ok"); if (viewId === v.id) applyView(null); loadViews(); };
  const exportCsv = async () => { try { await downloadFile(`/api/${exportUrl}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, ...(extraParams ?? {}) })}`); toast("Exportación descargada", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const currentView = views.find((v) => v.id === viewId);
  const clearSel = () => { setSel([]); setTick((t) => t + 1); };

  // Inline edit: optimistic update + silent reload
  const edit = async (c: Column<T>, row: T, value: unknown) => {
    if (!c.onEdit) return;
    const prev = data;
    setData((d) => d ? { ...d, items: d.items.map((r) => (r.id === row.id ? setPath(r, c.key, value) : r)) } : d);
    try { await c.onEdit(row, value); load(true); } catch (e) { setData(prev); toast(errorMessage(e), "error"); }
  };

  // Grouping
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    if (!groupBy) return [{ key: "all", label: "", color: "var(--c-blue)", rows: items }];
    const map = new Map<string, T[]>();
    for (const r of items) { const k = groupBy.get(r); map.set(k, [...(map.get(k) ?? []), r]); }
    const out = groupBy.groups.map((g) => ({ ...g, rows: map.get(g.key) ?? [] }));
    const known = new Set(groupBy.groups.map((g) => g.key));
    const rest = items.filter((r) => !known.has(groupBy.get(r)));
    if (rest.length) out.push({ key: "__other", label: groupBy.other ?? "Otros", color: "var(--c-grey)", rows: rest });
    return out.filter((g) => g.rows.length > 0 || !dq && filters.conditions.length === 0);
  }, [data, groupBy, dq, filters]);

  return (
    <div>
      <div className="filterbar">
        {onNew && <button className="btn primary" onClick={onNew}><Plus />{newLabel ?? "Nuevo"}</button>}
        <input className="input" style={{ maxWidth: 240 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Menu trigger={<button className="btn ghost"><Bookmark />{currentView ? currentView.name : "Todas"}<ChevronDown /></button>}>
          <button onClick={() => applyView(null)}>Todos los registros</button>
          {views.length > 0 && <div className="sep" />}
          {views.map((v) => <button key={v.id} onClick={() => applyView(v)} style={{ fontWeight: v.id === viewId ? 700 : 400 }}>{v.name}{v.shared ? <span className="badge xs right">compartida</span> : null}{(v.user_id === me.id || me.role.permissions.admin) && <span className="iconbtn" style={{ width: 20, height: 20, marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); deleteView(v); }} title="Borrar vista"><X size={12} /></span>}</button>)}
        </Menu>
        <button className={`btn ghost ${filters.conditions.length ? "on" : ""}`} onClick={() => setShowFilters(true)}><Filter />Filtros{filters.conditions.length ? ` (${filters.conditions.length})` : ""}</button>
        {filters.conditions.length > 0 && <button className="btn ghost sm" onClick={() => { setFilters(EMPTY); setViewId(null); }}><X />Limpiar</button>}
        <span className="right row">
          {toolbar}
          <button className="btn ghost" onClick={() => setShowCols(true)} title="Columnas"><Columns3 /></button>
          {filters.conditions.length > 0 && <button className="btn ghost" onClick={() => setSaveView(true)} title="Guardar vista"><Save /></button>}
          {exportUrl && <button className="btn ghost" onClick={exportCsv} title="Exportar CSV"><Download /></button>}
        </span>
      </div>
      {filters.conditions.length > 0 && <div className="small sub mb8">Filtro: {describeFilters(filters)}</div>}

      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && <div className="card"><Empty title={emptyText ?? "No hay registros"} text={dq || filters.conditions.length ? "Prueba a cambiar la búsqueda o los filtros." : undefined} /></div>}
      {data && data.items.length > 0 && groups.map((g) => (
        <div key={g.key} className={`mgroup ${collapsed[g.key] ? "collapsed" : ""}`} style={{ "--gc": g.color } as React.CSSProperties}>
          {groupBy && <div className="ghead"><button className="caret" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))} aria-label="Plegar grupo"><Caret size={16} /></button><h2>{g.label}</h2><span className="count">{g.rows.length} {g.rows.length === 1 ? "elemento" : "elementos"}</span></div>}
          <div className="mwrap">
            <table className="mtbl">
              <thead><tr>
                <th className="gbar" />
                {bulkActions && <th className="check"><input type="checkbox" checked={g.rows.length > 0 && g.rows.every((r) => sel.includes(r.id))} onChange={(e) => setSel((s) => (e.target.checked ? Array.from(new Set([...s, ...g.rows.map((r) => r.id)])) : s.filter((id) => !g.rows.some((r) => r.id === id))))} /></th>}
                {cols.map((c, i) => <th key={c.key} className={`${i === 0 || c.type === "name" ? "l" : ""} ${c.className ?? ""}`} onClick={() => toggleSort(c)} style={c.width ? { width: c.width, minWidth: c.width } : undefined}>{c.label}{sort.field === c.key && (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</th>)}
                <th className="menu" />
              </tr></thead>
              <tbody>
                {g.rows.map((row) => (
                  <tr key={row.id} className={sel.includes(row.id) ? "sel" : ""}>
                    <td className="gbar" />
                    {bulkActions && <td className="check"><input type="checkbox" checked={sel.includes(row.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, row.id] : s.filter((x) => x !== row.id)))} /></td>}
                    {cols.map((c, i) => <Cell key={c.key} col={c} row={row} first={i === 0} onOpen={onRowClick} onEdit={(v) => edit(c, row, v)} />)}
                    <td className="menu">{(onRowClick || onDelete) && <Menu trigger={<button className="menu-dot" aria-label="Acciones">⋯</button>}>{onRowClick && <button onClick={() => onRowClick(row)}>Abrir</button>}{onDelete && <button onClick={() => onDelete([row.id])} style={{ color: "var(--risk)" }}><Trash2 />Borrar</button>}</Menu>}</td>
                  </tr>
                ))}
                {g.rows.length === 0 && <tr><td className="gbar" />{bulkActions && <td />}<td colSpan={cols.length + 1} className="muted" style={{ textAlign: "left" }}>Sin elementos en este grupo</td></tr>}
                {g.rows.length > 0 && <tr className="sum">
                  <td className="gbar" />{bulkActions && <td />}
                  {cols.map((c) => <td key={c.key} className={c.type === "money" || c.type === "number" ? "sum" : ""}>{summary(c, g.rows)}</td>)}
                  <td />
                </tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {data && data.total > pageSize && <div className="card tight" style={{ padding: "0 8px" }}><Pager page={page} pageSize={pageSize} total={data.total} onPage={setPage} /></div>}

      {sel.length > 0 && bulkActions && <div className="sel-bar"><span className="n">{sel.length}</span><span className="small sub" style={{ marginRight: 8 }}>seleccionados</span>{bulkActions(sel, clearSel)}<button className="iconbtn" onClick={() => setSel([])} aria-label="Quitar selección"><X size={16} /></button></div>}

      {showFilters && (
        <Modal title="Filtros" size="lg" onClose={() => setShowFilters(false)} footer={<><button className="btn" onClick={() => { setFilters(EMPTY); setShowFilters(false); }}>Quitar todos</button><button className="btn primary" onClick={() => setShowFilters(false)}>Aplicar</button></>}>
          <FilterBuilder object={object} value={filters} onChange={setFilters} />
        </Modal>
      )}
      {showCols && (
        <Modal title="Columnas visibles" onClose={() => setShowCols(false)}>
          <div className="col">{columns.map((c) => <label key={c.key} className="checkbox"><input type="checkbox" checked={visible.includes(c.key)} onChange={(e) => saveCols(e.target.checked ? [...visible, c.key] : visible.filter((k) => k !== c.key))} />{c.label}</label>)}</div>
        </Modal>
      )}
      {saveView && <SaveViewDialog object={object} filters={filters} columns={visible} sort={sort} onClose={() => setSaveView(false)} onSaved={(v) => { loadViews().then(() => setViewId(v.id)); }} />}
    </div>
  );
}

function setPath<T>(row: T, key: string, value: unknown): T {
  const out = { ...(row as Record<string, unknown>) };
  const parts = key.split(".");
  let o: Record<string, unknown> = out;
  parts.slice(0, -1).forEach((k) => { o[k] = { ...((o[k] as Record<string, unknown>) ?? {}) }; o = o[k] as Record<string, unknown>; });
  o[parts[parts.length - 1]!] = value;
  return out as T;
}

function summary<T>(c: Column<T>, rows: T[]): ReactNode {
  const val = (r: T) => (c.value ? c.value(r) : getPath(r, c.key));
  if (c.agg === "none") return null;
  if (c.type === "money" || c.type === "number") {
    const s = rows.reduce((a, r) => a + (Number(val(r)) || 0), 0);
    const avg = c.agg === "avg";
    const v = avg ? s / Math.max(1, rows.length) : s;
    return <><b>{c.type === "money" ? fmtMoney(v) : fmtNum(Math.round(v * 10) / 10)}{avg && c.type === "number" && c.key === "probability" ? "%" : ""}</b>{avg ? "media" : "suma"}</>;
  }
  if (c.type === "status" && c.options) {
    const counts = new Map<string, number>();
    rows.forEach((r) => { const k = String(val(r) ?? ""); counts.set(k, (counts.get(k) ?? 0) + 1); });
    return <div className="dist" title={Array.from(counts).map(([k, n]) => `${c.options?.[k]?.label ?? k}: ${n}`).join(" · ")}>{Array.from(counts).map(([k, n]) => <i key={k} style={{ width: `${(n / rows.length) * 100}%`, background: c.options?.[k]?.color ?? "var(--c-grey)" }} />)}</div>;
  }
  return null;
}

function Cell<T extends { id: string }>({ col: c, row, first, onOpen, onEdit }: { col: Column<T>; row: T; first: boolean; onOpen?: (row: T) => void; onEdit: (v: unknown) => void }) {
  const raw = c.value ? c.value(row) : getPath(row, c.key);
  const [editing, setEditing] = useState(false);
  const [dd, setDd] = useState<{ x: number; y: number } | null>(null);
  const { users } = useApp();
  const editable = !!c.onEdit;
  const openDd = (e: React.MouseEvent) => { if (!editable) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setDd({ x: Math.min(r.left, window.innerWidth - 260), y: r.bottom + 4 }); };
  const type = c.type ?? (first ? "name" : "text");

  if (type === "name") {
    return <td className={`name l ${c.className ?? ""}`} onClick={() => onOpen?.(row)} style={onOpen ? { cursor: "pointer" } : undefined}>{c.render ? c.render(row) : <a href="#" onClick={(e) => { e.preventDefault(); onOpen?.(row); }}>{String(raw ?? "")}</a>}{c.sub && <span className="sub ell">{c.sub(row)}</span>}</td>;
  }
  if (type === "status") {
    const opt = c.options?.[String(raw ?? "")];
    return (
      <td className={`status ${c.className ?? ""}`} onClick={openDd} style={!editable ? { cursor: "default" } : undefined}>
        <div className="pill" style={{ background: opt?.color ?? "var(--c-grey)" }}>{opt?.label ?? (raw ? String(raw) : "—")}</div>
        {dd && <Dropdown at={dd} onClose={() => setDd(null)}>{Object.entries(c.options ?? {}).map(([k, o]) => <button key={k} style={{ background: o.color }} onClick={() => { setDd(null); if (k !== raw) onEdit(k); }}>{o.label}</button>)}</Dropdown>}
      </td>
    );
  }
  if (type === "person") {
    const name = c.render ? null : (raw as string | null);
    return (
      <td className={`person ${c.className ?? ""}`} onClick={openDd} style={!editable ? { cursor: "default" } : undefined} title={name ?? undefined}>
        {c.render ? c.render(row) : name ? <Avatar name={name} /> : <span className="none"><Plus size={12} /></span>}
        {dd && <Dropdown at={dd} list onClose={() => setDd(null)}><button onClick={() => { setDd(null); onEdit(null); }}><span className="none" style={{ width: 24, height: 24, display: "inline-grid", placeItems: "center", border: "1px dashed var(--rule)", borderRadius: "50%" }}>–</span>Sin asignar</button>{users.filter((u) => u.active).map((u) => <button key={u.id} onClick={() => { setDd(null); onEdit(u.id); }}><Avatar name={u.name} size="sm" />{u.name}</button>)}</Dropdown>}
      </td>
    );
  }
  if (type === "date") {
    const d = raw ? new Date(String(raw)) : null;
    const late = d && d.getTime() < Date.now();
    const soon = d && !late && d.getTime() - Date.now() < 3 * 86400000;
    return (
      <td className={`date edit ${c.className ?? ""}`} onClick={() => editable && setEditing(true)}>
        {editing ? <input className="ce" type="date" autoFocus defaultValue={d ? d.toISOString().slice(0, 10) : ""} onBlur={(e) => { setEditing(false); const v = e.target.value || null; if (v !== (d ? d.toISOString().slice(0, 10) : null)) onEdit(v); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          : c.render ? c.render(row) : d ? <><i className={`ddot ${late ? "late" : soon ? "soon" : ""}`} />{fmtDate(String(raw), { day: "2-digit", month: "short" })}</> : <span className="muted">—</span>}
      </td>
    );
  }
  if (type === "money" || type === "number") {
    return (
      <td className={`r num edit ${c.className ?? ""}`} onClick={() => editable && setEditing(true)}>
        {editing ? <input className="ce" type="number" autoFocus defaultValue={Number(raw) || 0} style={{ textAlign: "right" }} onBlur={(e) => { setEditing(false); const v = Number(e.target.value); if (v !== Number(raw)) onEdit(v); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          : c.render ? c.render(row) : type === "money" ? fmtMoney(Number(raw)) : fmtNum(Number(raw))}
      </td>
    );
  }
  if (type === "tags") {
    const tags = Array.isArray(raw) ? (raw as string[]) : [];
    return <td className={`tags ${c.className ?? ""}`}>{c.render ? c.render(row) : tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>;
  }
  // text
  return (
    <td className={`${editable ? "edit" : ""} ${c.className ?? ""}`} onClick={() => editable && setEditing(true)}>
      {editing ? <input className="ce" autoFocus defaultValue={String(raw ?? "")} onBlur={(e) => { setEditing(false); if (e.target.value !== String(raw ?? "")) onEdit(e.target.value || null); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        : c.render ? c.render(row) : (raw === null || raw === undefined || raw === "" ? <span className="muted">—</span> : String(raw))}
    </td>
  );
}

function Dropdown({ at, list, children, onClose }: { at: { x: number; y: number }; list?: boolean; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);
  const y = Math.min(at.y, window.innerHeight - 300);
  return <div ref={ref} className={`cdd ${list ? "list" : ""}`} style={{ left: at.x, top: y }} onClick={(e) => e.stopPropagation()}>{children}</div>;
}

function SaveViewDialog({ object, filters, columns, sort, onClose, onSaved }: { object: string; filters: FilterGroup; columns: string[]; sort: { field: string; dir: string }; onClose: () => void; onSaved: (v: SavedView) => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const toast = useToast();
  const save = async () => { if (!name.trim()) return; try { const v = await api.post<SavedView>("views", { object, name, filters, columns, sort, shared }); toast("Vista guardada", "ok"); onSaved(v); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title="Guardar vista" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="col"><Field label="Nombre de la vista"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Ej. Leads calientes de Madrid" /></Field><label className="checkbox"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Compartir con todo el equipo</label></div>
    </Modal>
  );
}
