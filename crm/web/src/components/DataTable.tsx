import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Filter, Download, Columns3, Save, ChevronUp, ChevronDown, X, Bookmark } from "lucide-react";
import { api, qs, downloadFile } from "../api";
import { FilterBuilder, describeFilters, type FilterGroup } from "./FilterBuilder";
import { Modal, Pager, Spinner, Empty, Field, useToast, useDebounce, errorMessage, Menu } from "./ui";
import { useApp } from "../lib/app";

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; sortable?: boolean; className?: string; default?: boolean; width?: number }
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
}

const EMPTY: FilterGroup = { logic: "and", conditions: [] };

export function DataTable<T extends { id: string }>({ object, endpoint, columns, onRowClick, toolbar, bulkActions, exportUrl, extraParams, refreshKey, emptyText, defaultSort }: Props<T>) {
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

  const loadViews = () => api.get<{ items: SavedView[] }>(`views?object=${object}`).then((r) => setViews(r.items)).catch(() => undefined);
  useEffect(() => { loadViews(); /* eslint-disable-next-line */ }, [object]);
  useEffect(() => { if (viewId && views.length) { const v = views.find((x) => x.id === viewId); if (v) { setFilters(v.filters?.conditions ? v.filters : EMPTY); if (v.columns?.length) setVisible(v.columns); if (v.sort?.field) setSort({ field: v.sort.field, dir: (v.sort.dir as "asc") ?? "desc" }); } } /* eslint-disable-next-line */ }, [viewId, views.length]);
  useEffect(() => { setPage(1); }, [dq, filters, sort]);
  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams(params);
    if (dq) p.set("q", dq); else p.delete("q");
    if (filters.conditions.length) p.set("filters", JSON.stringify(filters)); else p.delete("filters");
    if (viewId) p.set("view", viewId); else p.delete("view");
    setParams(p, { replace: true });
    api.get<{ items: T[]; total: number }>(`${endpoint}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, page, page_size: pageSize, ...(extraParams ?? {}) })}`)
      .then((r) => { setData(r); setSel([]); })
      .catch((e) => toast(errorMessage(e), "error"))
      .finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [dq, filters, sort, page, pageSize, endpoint, refreshKey, tick, JSON.stringify(extraParams)]);

  const cols = useMemo(() => columns.filter((c) => visible.includes(c.key)), [columns, visible]);
  const toggleSort = (c: Column<T>) => { if (!c.sortable) return; setSort((s) => ({ field: c.key, dir: s.field === c.key && s.dir === "desc" ? "asc" : "desc" })); };
  const allSel = data && data.items.length > 0 && sel.length === data.items.length;
  const saveCols = (v: string[]) => { setVisible(v); localStorage.setItem(storageKey, JSON.stringify(v)); };
  const applyView = (v: SavedView | null) => { setViewId(v?.id ?? null); if (!v) { setFilters(EMPTY); } };
  const deleteView = async (v: SavedView) => { await api.del(`views/${v.id}`); toast("Vista borrada", "ok"); if (viewId === v.id) applyView(null); loadViews(); };
  const exportCsv = async () => { try { await downloadFile(`/api/${exportUrl}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, ...(extraParams ?? {}) })}`); toast("Exportación descargada", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const currentView = views.find((v) => v.id === viewId);

  return (
    <div>
      <div className="filterbar">
        <input className="input" style={{ maxWidth: 280 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Menu trigger={<button className={`btn ${currentView ? "" : ""}`}><Bookmark />{currentView ? currentView.name : "Todas"}<ChevronDown /></button>}>
          <button onClick={() => applyView(null)}>Todos los registros</button>
          {views.length > 0 && <div className="sep" />}
          {views.map((v) => <button key={v.id} onClick={() => applyView(v)} style={{ fontWeight: v.id === viewId ? 700 : 400 }}>{v.name}{v.shared ? <span className="badge xs right">compartida</span> : null}{(v.user_id === me.id || me.role.permissions.admin) && <span className="iconbtn" style={{ width: 20, height: 20, marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); deleteView(v); }} title="Borrar vista"><X size={12} /></span>}</button>)}
        </Menu>
        <button className={`btn ${filters.conditions.length ? "primary" : ""}`} onClick={() => setShowFilters(true)}><Filter />Filtros{filters.conditions.length ? ` (${filters.conditions.length})` : ""}</button>
        {filters.conditions.length > 0 && <button className="btn ghost sm" onClick={() => { setFilters(EMPTY); setViewId(null); }}><X />Limpiar</button>}
        <span className="right row">
          {toolbar}
          <button className="btn ghost" onClick={() => setShowCols(true)} title="Columnas"><Columns3 /></button>
          {filters.conditions.length > 0 && <button className="btn ghost" onClick={() => setSaveView(true)} title="Guardar vista"><Save /></button>}
          {exportUrl && <button className="btn ghost" onClick={exportCsv} title="Exportar CSV"><Download /></button>}
        </span>
      </div>
      {filters.conditions.length > 0 && <div className="small sub mb8">Filtro: {describeFilters(filters)}</div>}
      {sel.length > 0 && bulkActions && <div className="row wrap mb8 alert info"><strong>{sel.length} seleccionados</strong>{bulkActions(sel, () => { setSel([]); setTick((t) => t + 1); })}</div>}
      <div className="card tight">
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              {bulkActions && <th className="check"><input type="checkbox" checked={!!allSel} onChange={(e) => setSel(e.target.checked ? (data?.items.map((i) => i.id) ?? []) : [])} /></th>}
              {cols.map((c) => <th key={c.key} className={`${c.sortable ? "sortable" : ""} ${c.className ?? ""}`} onClick={() => toggleSort(c)} style={c.width ? { width: c.width } : undefined}>{c.label}{sort.field === c.key && (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</th>)}
            </tr></thead>
            <tbody>
              {data?.items.map((row) => (
                <tr key={row.id} className={onRowClick ? "clickable" : ""} onClick={() => onRowClick?.(row)}>
                  {bulkActions && <td className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.includes(row.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, row.id] : s.filter((x) => x !== row.id)))} /></td>}
                  {cols.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && !data && <Spinner />}
          {data && data.items.length === 0 && <Empty title={emptyText ?? "No hay registros"} text={dq || filters.conditions.length ? "Prueba a cambiar la búsqueda o los filtros." : undefined} />}
        </div>
        {data && <Pager page={page} pageSize={pageSize} total={data.total} onPage={setPage} />}
      </div>
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
