import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Filter, Download, Columns3, Save, ChevronUp, ChevronDown, X, Bookmark, ChevronDown as Caret, Plus, Trash2, Zap, Pencil, Palette, ArrowLeft, ArrowRight, EyeOff, Tag, Copy, FolderInput, Layers } from "lucide-react";
import { api, qs, downloadFile } from "../api";
import { FilterBuilder, describeFilters, type FilterGroup } from "./FilterBuilder";
import { Modal, Pager, Spinner, Empty, Field, useToast, useDebounce, errorMessage, Menu, Avatar, useConfirm } from "./ui";
import { useApp, type CustomField } from "../lib/app";
import { fmtMoney, fmtDate, fmtNum } from "../lib/format";
import { PALETTE, applyBoard, type Board } from "../lib/board";
import { BoardRules } from "./BoardRules";

export type ColumnType = "text" | "name" | "status" | "person" | "money" | "number" | "date" | "tags" | "check";
export interface StatusOption { label: string; color: string }
export interface Column<T> {
  key: string; label: string; render?: (row: T) => ReactNode; sortable?: boolean; className?: string; default?: boolean; width?: number;
  type?: ColumnType;
  options?: Record<string, StatusOption>;
  value?: (row: T) => unknown;
  onEdit?: (row: T, value: unknown) => Promise<void> | void;
  agg?: "sum" | "avg" | "none";
  sub?: (row: T) => ReactNode;
  /** set when the column is a custom field (allows deleting / editing options) */
  custom?: CustomField;
  /** built-in status columns whose option set is fixed (labels/colours still editable) */
  fixedOptions?: boolean;
}
export interface Group { key: string; label: string; color: string }
export interface GroupOption<T> {
  key: string; label: string;
  get: (row: T) => string;
  groups: Group[];
  /** move a row into a group (used by the row menu); omitted = not movable */
  setValue?: (row: T, groupKey: string) => Promise<void> | void;
  /** extra payload when creating a row inside a group */
  createValue?: (groupKey: string) => Record<string, unknown>;
  other?: string;
}
export interface SavedView { id: string; object: string; name: string; filters: FilterGroup; columns: string[]; sort: { field?: string; dir?: string }; shared: number; user_id: string }

interface Props<T> {
  object: "contact" | "company" | "deal" | "ticket" | "contract";
  endpoint: string;
  columns: Column<T>[];
  board: Board;
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  bulkActions?: (ids: string[], clear: () => void) => ReactNode;
  exportUrl?: string;
  extraParams?: Record<string, unknown>;
  refreshKey?: number;
  emptyText?: string;
  defaultSort?: { field: string; dir: "asc" | "desc" };
  groupOptions?: GroupOption<T>[];
  defaultGroup?: string;
  onNew?: () => void;
  newLabel?: string;
  onCreate?: (name: string, extra: Record<string, unknown>) => Promise<void> | void;
  onDuplicate?: (row: T) => Promise<void> | void;
  onDelete?: (ids: string[]) => Promise<void> | void;
}

const EMPTY: FilterGroup = { logic: "and", conditions: [] };
const getPath = (row: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);

export function DataTable<T extends { id: string }>({ object, endpoint, columns: rawColumns, board, onRowClick, toolbar, bulkActions, exportUrl, extraParams, refreshKey, emptyText, defaultSort, groupOptions, defaultGroup, onNew, newLabel, onCreate, onDuplicate, onDelete }: Props<T>) {
  const { me, refresh, can } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const storageKey = `crm:cols:${object}`;
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounce(q, 250);
  const [filters, setFilters] = useState<FilterGroup>(() => { try { return params.get("filters") ? JSON.parse(params.get("filters")!) : EMPTY; } catch { return EMPTY; } });
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>(defaultSort ?? { field: "updated_at", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [saveView, setSaveView] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState<string | null>(params.get("view"));
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addCol, setAddCol] = useState(false);
  const [labelsFor, setLabelsFor] = useState<Column<T> | null>(null);
  const [rules, setRules] = useState(false);
  const [renaming, setRenaming] = useState<Column<T> | null>(null);
  const canEdit = can(object, "update");

  const columns = useMemo(() => applyBoard(rawColumns, board), [rawColumns, board.config]);
  const [visible, setVisible] = useState<string[] | null>(() => { try { const s = localStorage.getItem(storageKey); if (s) return JSON.parse(s); } catch { /* ignore */ } return null; });
  const visibleKeys = useMemo(() => visible ?? columns.filter((c) => c.default !== false).map((c) => c.key), [visible, columns]);

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

  const cols = useMemo(() => columns.filter((c) => visibleKeys.includes(c.key)), [columns, visibleKeys]);
  const saveCols = (v: string[]) => { setVisible(v); localStorage.setItem(storageKey, JSON.stringify(v)); };
  const applyView = (v: SavedView | null) => { setViewId(v?.id ?? null); if (!v) { setFilters(EMPTY); } };
  const deleteView = async (v: SavedView) => { await api.del(`views/${v.id}`); toast("Vista borrada", "ok"); if (viewId === v.id) applyView(null); loadViews(); };
  const exportCsv = async () => { try { await downloadFile(`/api/${exportUrl}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, ...(extraParams ?? {}) })}`); toast("Exportación descargada", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const currentView = views.find((v) => v.id === viewId);
  const clearSel = () => { setSel([]); setTick((t) => t + 1); };
  const reload = () => setTick((t) => t + 1);

  // ---- board column config helpers ----
  const setColCfg = (key: string, patch: { label?: string; width?: number; hidden?: boolean }) => board.update((c) => { const cols = [...(c.columns ?? [])]; const i = cols.findIndex((x) => x.key === key); if (i >= 0) cols[i] = { ...cols[i]!, ...patch }; else cols.push({ key, ...patch }); return { ...c, columns: cols }; });
  const moveCol = (key: string, dir: -1 | 1) => {
    const order = columns.map((c) => c.key); const i = order.indexOf(key); const j = i + dir; if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    board.update((c) => ({ ...c, order }));
  };
  const deleteCustom = async (c: Column<T>) => { if (!c.custom) return; if (!(await confirm({ title: `¿Borrar la columna «${c.label}»?`, text: "Se eliminará el campo y sus valores en todos los registros.", danger: true, confirmText: "Borrar" }))) return; await api.del(`admin/custom-fields/${c.custom.id}`); toast("Columna borrada", "ok"); await refresh(); reload(); };

  // ---- inline edit ----
  const edit = async (c: Column<T>, row: T, value: unknown) => {
    if (!c.onEdit) return;
    const prev = data;
    setData((d) => d ? { ...d, items: d.items.map((r) => (r.id === row.id ? setPath(r, c.key, value) : r)) } : d);
    try { await c.onEdit(row, value); load(true); } catch (e) { setData(prev); toast(errorMessage(e), "error"); }
  };

  // ---- grouping ----
  const groupKey = board.config.group_by === undefined ? (defaultGroup ?? groupOptions?.[0]?.key ?? null) : board.config.group_by;
  const go = groupOptions?.find((g) => g.key === groupKey) ?? null;
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    if (!go) return [{ key: "all", label: "", color: "var(--c-blue)", rows: items, hidden: false }];
    const ov = board.config.groups?.[go.key] ?? {};
    const order = board.config.group_order?.[go.key];
    const map = new Map<string, T[]>();
    for (const r of items) { const k = go.get(r); map.set(k, [...(map.get(k) ?? []), r]); }
    let defs = go.groups.map((g) => ({ ...g, label: ov[g.key]?.label ?? g.label, color: ov[g.key]?.color ?? g.color, hidden: !!ov[g.key]?.hidden, rows: map.get(g.key) ?? [] }));
    if (order) defs = [...defs].sort((a, b) => { const ia = order.indexOf(a.key), ib = order.indexOf(b.key); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
    const known = new Set(go.groups.map((g) => g.key));
    const rest = items.filter((r) => !known.has(go.get(r)));
    if (rest.length) defs.push({ key: "__other", label: go.other ?? "Otros", color: "var(--c-grey)", hidden: false, rows: rest });
    return defs.filter((g) => !g.hidden && (g.rows.length > 0 || (!dq && filters.conditions.length === 0)));
  }, [data, go, board.config, dq, filters]);
  const setGroupCfg = (gk: string, patch: { label?: string; color?: string; hidden?: boolean }) => { if (!go) return; board.update((c) => ({ ...c, groups: { ...(c.groups ?? {}), [go.key]: { ...(c.groups?.[go.key] ?? {}), [gk]: { ...(c.groups?.[go.key]?.[gk] ?? {}), ...patch } } } })); };
  const moveGroup = (gk: string, dir: -1 | 1) => { if (!go) return; const order = groups.map((g) => g.key); const i = order.indexOf(gk); const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j]!, order[i]!]; board.update((c) => ({ ...c, group_order: { ...(c.group_order ?? {}), [go.key]: order } })); };
  const moveRow = async (row: T, gk: string) => { if (!go?.setValue) return; try { await go.setValue(row, gk); load(true); toast("Movido", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const create = async (name: string, gk: string) => { if (!onCreate || !name.trim()) return; try { await onCreate(name.trim(), go?.createValue?.(gk) ?? {}); load(true); toast("Creado", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const duplicate = async (row: T) => { if (!onDuplicate) return; try { await onDuplicate(row); load(true); toast("Duplicado", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };

  const headerMenu = (c: Column<T>) => (
    <Menu trigger={<button className="th-menu" aria-label="Opciones de columna"><Caret size={13} /></button>}>
      {c.sortable && <button onClick={() => setSort({ field: c.key, dir: "asc" })}><ChevronUp />Ordenar ascendente</button>}
      {c.sortable && <button onClick={() => setSort({ field: c.key, dir: "desc" })}><ChevronDown />Ordenar descendente</button>}
      {canEdit && <button onClick={() => setRenaming(c)}><Pencil />Renombrar</button>}
      {canEdit && c.type === "status" && <button onClick={() => setLabelsFor(c)}><Tag />Editar etiquetas</button>}
      {canEdit && <button onClick={() => moveCol(c.key, -1)}><ArrowLeft />Mover a la izquierda</button>}
      {canEdit && <button onClick={() => moveCol(c.key, 1)}><ArrowRight />Mover a la derecha</button>}
      {canEdit && <button onClick={() => setColCfg(c.key, { width: c.width && c.width > 160 ? 120 : c.width && c.width > 120 ? 260 : 180 })}><Columns3 />Ancho: {c.width && c.width > 160 ? "estrecho" : c.width && c.width > 120 ? "ancho" : "normal"}</button>}
      <button onClick={() => saveCols(visibleKeys.filter((k) => k !== c.key))}><EyeOff />Ocultar columna</button>
      {canEdit && c.custom && <button onClick={() => deleteCustom(c)} style={{ color: "var(--risk)" }}><Trash2 />Borrar columna</button>}
    </Menu>
  );

  return (
    <div>
      <div className="filterbar">
        {onNew && <button className="btn primary" onClick={onNew}><Plus />{newLabel ?? "Nuevo"}</button>}
        <input className="input" style={{ maxWidth: 220 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Menu trigger={<button className="btn ghost"><Bookmark />{currentView ? currentView.name : "Todas"}<ChevronDown /></button>}>
          <button onClick={() => applyView(null)}>Todos los registros</button>
          {views.length > 0 && <div className="sep" />}
          {views.map((v) => <button key={v.id} onClick={() => applyView(v)} style={{ fontWeight: v.id === viewId ? 700 : 400 }}>{v.name}{v.shared ? <span className="badge xs right">compartida</span> : null}{(v.user_id === me.id || me.role.permissions.admin) && <span className="iconbtn" style={{ width: 20, height: 20, marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); deleteView(v); }} title="Borrar vista"><X size={12} /></span>}</button>)}
        </Menu>
        <button className={`btn ghost ${filters.conditions.length ? "on" : ""}`} onClick={() => setShowFilters(true)}><Filter />Filtros{filters.conditions.length ? ` (${filters.conditions.length})` : ""}</button>
        {filters.conditions.length > 0 && <button className="btn ghost sm" onClick={() => { setFilters(EMPTY); setViewId(null); }}><X />Limpiar</button>}
        {groupOptions && groupOptions.length > 0 && (
          <Menu trigger={<button className="btn ghost"><Layers />{go ? `Agrupar: ${columns.find((c) => c.key === go.key)?.label ?? go.label}` : "Sin agrupar"}<ChevronDown /></button>}>
            <button onClick={() => board.update({ group_by: null })} style={{ fontWeight: !go ? 700 : 400 }}>Sin agrupar</button>
            <div className="sep" />
            {groupOptions.map((g) => <button key={g.key} onClick={() => board.update({ group_by: g.key })} style={{ fontWeight: go?.key === g.key ? 700 : 400 }}>{columns.find((c) => c.key === g.key)?.label ?? g.label}</button>)}
          </Menu>
        )}
        <button className="btn ghost" onClick={() => setRules(true)}><Zap />Automatizaciones</button>
        <span className="right row">
          {toolbar}
          <button className="btn ghost" onClick={() => setShowCols(true)} title="Columnas"><Columns3 /></button>
          {filters.conditions.length > 0 && <button className="btn ghost" onClick={() => setSaveView(true)} title="Guardar vista"><Save /></button>}
          {exportUrl && <button className="btn ghost" onClick={exportCsv} title="Exportar CSV"><Download /></button>}
        </span>
      </div>
      {filters.conditions.length > 0 && <div className="small sub mb8">Filtro: {describeFilters(filters)}</div>}

      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && !onCreate && <div className="card"><Empty title={emptyText ?? "No hay registros"} text={dq || filters.conditions.length ? "Prueba a cambiar la búsqueda o los filtros." : undefined} /></div>}
      {data && (data.items.length > 0 || onCreate) && groups.map((g) => (
        <div key={g.key} className={`mgroup ${collapsed[g.key] ? "collapsed" : ""}`} style={{ "--gc": g.color } as React.CSSProperties}>
          {go && (
            <div className="ghead">
              <button className="caret" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))} aria-label="Plegar grupo"><Caret size={16} /></button>
              <GroupTitle label={g.label} color={g.color} editable={canEdit && g.key !== "__other"} onRename={(l) => setGroupCfg(g.key, { label: l })} onColor={(c) => setGroupCfg(g.key, { color: c })} />
              <span className="count">{g.rows.length} {g.rows.length === 1 ? "elemento" : "elementos"}</span>
              {canEdit && g.key !== "__other" && (
                <Menu trigger={<button className="menu-dot show" aria-label="Opciones del grupo">⋯</button>}>
                  <button onClick={() => moveGroup(g.key, -1)}><ChevronUp />Subir grupo</button>
                  <button onClick={() => moveGroup(g.key, 1)}><ChevronDown />Bajar grupo</button>
                  <button onClick={() => setCollapsed(Object.fromEntries(groups.map((x) => [x.key, true])))}>Plegar todos</button>
                  <button onClick={() => setCollapsed({})}>Desplegar todos</button>
                  <button onClick={() => setGroupCfg(g.key, { hidden: true })}><EyeOff />Ocultar grupo</button>
                </Menu>
              )}
            </div>
          )}
          <div className="mwrap">
            <table className="mtbl">
              <thead><tr>
                <th className="gbar" />
                {bulkActions && <th className="check"><input type="checkbox" checked={g.rows.length > 0 && g.rows.every((r) => sel.includes(r.id))} onChange={(e) => setSel((s) => (e.target.checked ? Array.from(new Set([...s, ...g.rows.map((r) => r.id)])) : s.filter((id) => !g.rows.some((r) => r.id === id))))} /></th>}
                {cols.map((c, i) => <th key={c.key} className={`${i === 0 || c.type === "name" ? "l" : ""} ${c.className ?? ""}`} style={c.width ? { width: c.width, minWidth: c.width } : undefined}><span className="th-in"><span className="th-label" onClick={() => c.sortable && setSort((s) => ({ field: c.key, dir: s.field === c.key && s.dir === "desc" ? "asc" : "desc" }))}>{c.label}{sort.field === c.key && (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</span>{headerMenu(c)}</span></th>)}
                <th className="menu addcol">{canEdit && <button className="menu-dot show" title="Añadir columna" onClick={() => setAddCol(true)}><Plus size={15} /></button>}</th>
              </tr></thead>
              <tbody>
                {g.rows.map((row) => (
                  <tr key={row.id} className={sel.includes(row.id) ? "sel" : ""}>
                    <td className="gbar" />
                    {bulkActions && <td className="check"><input type="checkbox" checked={sel.includes(row.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, row.id] : s.filter((x) => x !== row.id)))} /></td>}
                    {cols.map((c, i) => <Cell key={c.key} col={c} row={row} first={i === 0} onOpen={onRowClick} onEdit={(v) => edit(c, row, v)} onEditLabels={canEdit ? () => setLabelsFor(c) : undefined} />)}
                    <td className="menu">
                      <Menu trigger={<button className="menu-dot" aria-label="Acciones">⋯</button>}>
                        {onRowClick && <button onClick={() => onRowClick(row)}>Abrir</button>}
                        {onDuplicate && <button onClick={() => duplicate(row)}><Copy />Duplicar</button>}
                        {go?.setValue && groups.filter((x) => x.key !== g.key && x.key !== "__other").map((x) => <button key={x.key} onClick={() => moveRow(row, x.key)}><FolderInput />Mover a <span className="gdot" style={{ background: x.color }} />{x.label}</button>)}
                        {onDelete && <button onClick={() => onDelete([row.id])} style={{ color: "var(--risk)" }}><Trash2 />Borrar</button>}
                      </Menu>
                    </td>
                  </tr>
                ))}
                {g.rows.length === 0 && !onCreate && <tr><td className="gbar" />{bulkActions && <td />}<td colSpan={cols.length + 1} className="muted" style={{ textAlign: "left" }}>Sin elementos en este grupo</td></tr>}
                {onCreate && canEdit && <AddRow colSpan={cols.length + 1 + (bulkActions ? 1 : 0)} onCreate={(name) => create(name, g.key)} />}
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
      {go && canEdit && Object.values(board.config.groups?.[go.key] ?? {}).some((x) => x.hidden) && <button className="btn ghost sm" onClick={() => board.update((c) => ({ ...c, groups: { ...(c.groups ?? {}), [go.key]: Object.fromEntries(Object.entries(c.groups?.[go.key] ?? {}).map(([k, v]) => [k, { ...v, hidden: false }])) } }))}>Mostrar grupos ocultos</button>}
      {data && data.total > pageSize && <div className="card tight" style={{ padding: "0 8px" }}><Pager page={page} pageSize={pageSize} total={data.total} onPage={setPage} /></div>}

      {sel.length > 0 && bulkActions && <div className="sel-bar"><span className="n">{sel.length}</span><span className="small sub" style={{ marginRight: 8 }}>seleccionados</span>{bulkActions(sel, clearSel)}{onDelete && <button className="btn sm danger" onClick={async () => { await onDelete(sel); clearSel(); }}><Trash2 />Borrar</button>}<button className="iconbtn" onClick={() => setSel([])} aria-label="Quitar selección"><X size={16} /></button></div>}

      {showFilters && (
        <Modal title="Filtros" size="lg" onClose={() => setShowFilters(false)} footer={<><button className="btn" onClick={() => { setFilters(EMPTY); setShowFilters(false); }}>Quitar todos</button><button className="btn primary" onClick={() => setShowFilters(false)}>Aplicar</button></>}>
          <FilterBuilder object={object} value={filters} onChange={setFilters} />
        </Modal>
      )}
      {showCols && (
        <Modal title="Columnas visibles" onClose={() => setShowCols(false)} footer={canEdit ? <button className="btn primary" onClick={() => { setShowCols(false); setAddCol(true); }}><Plus />Nueva columna</button> : undefined}>
          <div className="col">{columns.map((c) => <label key={c.key} className="checkbox"><input type="checkbox" checked={visibleKeys.includes(c.key)} onChange={(e) => saveCols(e.target.checked ? [...visibleKeys, c.key] : visibleKeys.filter((k) => k !== c.key))} />{c.label}{c.custom && <span className="xs muted" style={{ marginLeft: 6 }}>personalizada</span>}</label>)}</div>
        </Modal>
      )}
      {saveView && <SaveViewDialog object={object} filters={filters} columns={visibleKeys} sort={sort} onClose={() => setSaveView(false)} onSaved={(v) => { loadViews().then(() => setViewId(v.id)); }} />}
      {addCol && <AddColumnDialog object={object} onClose={() => setAddCol(false)} onCreated={async (f) => { await refresh(); saveCols([...visibleKeys, `custom.${f.key}`]); reload(); }} />}
      {labelsFor && <LabelsDialog col={labelsFor} board={board} onClose={() => setLabelsFor(null)} onChanged={async () => { await refresh(); reload(); }} />}
      {renaming && <RenameDialog title="Renombrar columna" value={renaming.label} onClose={() => setRenaming(null)} onSave={(l) => { setColCfg(renaming.key, { label: l }); setRenaming(null); }} />}
      {rules && <BoardRules object={object} columns={columns as Column<unknown>[]} onClose={() => setRules(false)} />}
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
  if (c.type === "check") { const n = rows.filter((r) => !!val(r)).length; return <span className="small sub">{n}/{rows.length}</span>; }
  return null;
}

function GroupTitle({ label, color, editable, onRename, onColor }: { label: string; color: string; editable: boolean; onRename: (l: string) => void; onColor: (c: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(false);
  if (editing) return <input className="input sm" autoFocus defaultValue={label} style={{ width: 220, color }} onBlur={(e) => { setEditing(false); if (e.target.value.trim() && e.target.value.trim() !== label) onRename(e.target.value.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }} />;
  return (
    <span className="row" style={{ gap: 6, position: "relative" }}>
      <h2 onClick={() => editable && setEditing(true)} style={editable ? { cursor: "text" } : undefined} title={editable ? "Clic para renombrar" : undefined}>{label}</h2>
      {editable && <button className="iconbtn" style={{ width: 22, height: 22 }} title="Color del grupo" onClick={() => setPick((p) => !p)}><Palette size={13} /></button>}
      {pick && <ColorPicker value={color} onPick={(c) => { onColor(c); setPick(false); }} onClose={() => setPick(false)} />}
    </span>
  );
}

export function ColorPicker({ value, onPick, onClose }: { value: string; onPick: (c: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }; setTimeout(() => document.addEventListener("mousedown", h), 0); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  return <div ref={ref} className="cpick">{PALETTE.map((c) => <button key={c} style={{ background: c, outline: c === value ? "2px solid var(--ink)" : undefined }} onClick={() => onPick(c)} aria-label={c} />)}</div>;
}

function AddRow({ colSpan, onCreate }: { colSpan: number; onCreate: (name: string) => Promise<void> | void }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => { if (!v.trim() || busy) return; setBusy(true); try { await onCreate(v); setV(""); } finally { setBusy(false); } };
  return <tr className="addrow"><td className="gbar" /><td colSpan={colSpan} className="l"><span className="row"><Plus size={14} className="muted" /><input className="addrow-in" placeholder="+ Añadir elemento" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setV(""); }} onBlur={() => v.trim() && submit()} /></span></td></tr>;
}

function Cell<T extends { id: string }>({ col: c, row, first, onOpen, onEdit, onEditLabels }: { col: Column<T>; row: T; first: boolean; onOpen?: (row: T) => void; onEdit: (v: unknown) => void; onEditLabels?: () => void }) {
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
        {dd && <Dropdown at={dd} onClose={() => setDd(null)} footer={onEditLabels ? <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => { setDd(null); onEditLabels(); }}><Pencil />Editar etiquetas</button> : undefined}>{Object.entries(c.options ?? {}).map(([k, o]) => <button key={k} style={{ background: o.color }} onClick={() => { setDd(null); if (k !== raw) onEdit(k); }}>{o.label}</button>)}{!c.fixedOptions && c.custom && <button style={{ background: "var(--panel)", color: "var(--ink2)", border: "1px dashed var(--rule)" }} onClick={() => { setDd(null); onEdit(null); }}>— vacío —</button>}</Dropdown>}
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
  if (type === "check") {
    const on = raw === true || raw === 1 || raw === "true";
    return <td className={`c ${c.className ?? ""}`} onClick={() => editable && onEdit(!on)} style={{ cursor: editable ? "pointer" : "default" }}><input type="checkbox" readOnly checked={on} style={{ accentColor: "var(--c-green)", width: 16, height: 16, pointerEvents: "none" }} /></td>;
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
        {editing ? <input className="ce" type="number" step="any" autoFocus defaultValue={raw == null ? "" : Number(raw)} style={{ textAlign: "right" }} onBlur={(e) => { setEditing(false); const v = e.target.value === "" ? null : Number(e.target.value); if (v !== (raw == null ? null : Number(raw))) onEdit(v); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          : c.render ? c.render(row) : raw == null || raw === "" ? <span className="muted">—</span> : type === "money" ? fmtMoney(Number(raw)) : fmtNum(Number(raw))}
      </td>
    );
  }
  if (type === "tags") {
    const tags = Array.isArray(raw) ? (raw as string[]) : [];
    return <td className={`tags ${c.className ?? ""}`}>{c.render ? c.render(row) : tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>;
  }
  return (
    <td className={`${editable ? "edit" : ""} ${c.className ?? ""}`} onClick={() => editable && setEditing(true)}>
      {editing ? <input className="ce" autoFocus defaultValue={String(raw ?? "")} onBlur={(e) => { setEditing(false); if (e.target.value !== String(raw ?? "")) onEdit(e.target.value || null); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        : c.render ? c.render(row) : (raw === null || raw === undefined || raw === "" ? <span className="muted">—</span> : String(raw))}
    </td>
  );
}

function Dropdown({ at, list, children, footer, onClose }: { at: { x: number; y: number }; list?: boolean; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);
  const y = Math.min(at.y, window.innerHeight - 320);
  return <div ref={ref} className={`cdd ${list ? "list" : ""}`} style={{ left: at.x, top: y }} onClick={(e) => e.stopPropagation()}>{children}{footer && <div className="cdd-foot">{footer}</div>}</div>;
}

const COL_TYPES: { key: CustomField["type"]; label: string; help: string }[] = [
  { key: "select", label: "Estado", help: "Etiquetas de color" }, { key: "text", label: "Texto", help: "Una línea" }, { key: "textarea", label: "Texto largo", help: "Varias líneas" },
  { key: "number", label: "Número", help: "" }, { key: "currency", label: "Importe", help: "Moneda" }, { key: "percent", label: "Porcentaje", help: "" }, { key: "date", label: "Fecha", help: "" }, { key: "datetime", label: "Fecha y hora", help: "" },
  { key: "user", label: "Persona", help: "Usuario del equipo" }, { key: "boolean", label: "Casilla", help: "Sí / no" }, { key: "multiselect", label: "Etiquetas múltiples", help: "" }, { key: "url", label: "Enlace", help: "" }, { key: "email", label: "Email", help: "" }, { key: "phone", label: "Teléfono", help: "" },
];
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]/, "c$&") || "campo";

function AddColumnDialog({ object, onClose, onCreated }: { object: string; onClose: () => void; onCreated: (f: CustomField) => Promise<void> }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomField["type"]>("select");
  const [options, setOptions] = useState<string[]>(["Pendiente", "En curso", "Hecho"]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!label.trim()) return; setBusy(true);
    try { const f = await api.post<CustomField>("admin/custom-fields", { object, key: slug(label), label: label.trim(), type, options: type === "select" || type === "multiselect" ? options.filter(Boolean) : undefined }); toast("Columna añadida", "ok"); await onCreated(f); onClose(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nueva columna" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !label.trim()} onClick={save}>Crear columna</button></>}>
      <div className="col" style={{ gap: 14 }}>
        <Field label="Nombre de la columna"><input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Prioridad interna" onKeyDown={(e) => e.key === "Enter" && save()} /></Field>
        <Field label="Tipo"><div className="type-grid">{COL_TYPES.map((t) => <button key={t.key} className={`type-btn ${type === t.key ? "active" : ""}`} onClick={() => setType(t.key)}><b>{t.label}</b>{t.help && <span>{t.help}</span>}</button>)}</div></Field>
        {(type === "select" || type === "multiselect") && <Field label="Opciones"><div className="col" style={{ gap: 6 }}>{options.map((o, i) => <div key={i} className="row"><span className="gdot" style={{ background: PALETTE[(i * 3) % PALETTE.length] }} /><input className="input sm" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} /><button className="iconbtn" onClick={() => setOptions(options.filter((_, j) => j !== i))}><X size={14} /></button></div>)}<button className="btn ghost sm" onClick={() => setOptions([...options, ""])}><Plus />Añadir opción</button></div></Field>}
      </div>
    </Modal>
  );
}

function LabelsDialog<T>({ col, board, onClose, onChanged }: { col: Column<T>; board: Board; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [opts, setOpts] = useState<{ key: string; label: string; color: string }[]>(() => Object.entries(col.options ?? {}).map(([key, o]) => ({ key, label: o.label, color: o.color })));
  const [pick, setPick] = useState<string | null>(null);
  const [newOpt, setNewOpt] = useState("");
  const custom = col.custom;
  const save = async () => {
    board.update((c) => ({ ...c, labels: { ...(c.labels ?? {}), [col.key]: Object.fromEntries(opts.map((o) => [o.key, { label: o.label, color: o.color }])) } }));
    toast("Etiquetas guardadas", "ok"); onClose();
  };
  const addOpt = async () => { const v = newOpt.trim(); if (!v || !custom) return; try { await api.put(`admin/custom-fields/${custom.id}`, { options: [...custom.options, v] }); setOpts([...opts, { key: v, label: v, color: PALETTE[(opts.length * 3) % PALETTE.length]! }]); setNewOpt(""); await onChanged(); } catch (e) { toast(errorMessage(e), "error"); } };
  const delOpt = async (k: string) => { if (!custom) return; if (!(await confirm({ title: `¿Quitar la etiqueta «${k}»?`, text: "Los registros con ese valor quedarán sin estado.", danger: true, confirmText: "Quitar" }))) return; try { await api.put(`admin/custom-fields/${custom.id}`, { options: custom.options.filter((o) => o !== k) }); setOpts(opts.filter((o) => o.key !== k)); await onChanged(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={`Etiquetas de «${col.label}»`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="col" style={{ gap: 8 }}>
        {opts.map((o) => (
          <div key={o.key} className="row" style={{ position: "relative" }}>
            <button className="swatch" style={{ background: o.color }} onClick={() => setPick(pick === o.key ? null : o.key)} aria-label="Color" />
            {pick === o.key && <ColorPicker value={o.color} onPick={(c) => { setOpts(opts.map((x) => (x.key === o.key ? { ...x, color: c } : x))); setPick(null); }} onClose={() => setPick(null)} />}
            <input className="input sm grow" value={o.label} onChange={(e) => setOpts(opts.map((x) => (x.key === o.key ? { ...x, label: e.target.value } : x)))} />
            {custom ? <button className="iconbtn" title="Quitar etiqueta" onClick={() => delOpt(o.key)}><Trash2 size={14} /></button> : <span className="xs muted" style={{ width: 90 }} title="Valor interno">{o.key}</span>}
          </div>
        ))}
        {custom && <div className="row"><input className="input sm grow" placeholder="Nueva etiqueta…" value={newOpt} onChange={(e) => setNewOpt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addOpt()} /><button className="btn sm" onClick={addOpt} disabled={!newOpt.trim()}><Plus />Añadir</button></div>}
        {!custom && <p className="xs muted">Esta columna forma parte del CRM: puedes cambiar el texto y el color de cada etiqueta. Para crear etiquetas nuevas, añade una columna de tipo Estado.</p>}
      </div>
    </Modal>
  );
}

export function RenameDialog({ title, value, onClose, onSave }: { title: string; value: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Guardar</button></>}><input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && v.trim() && onSave(v.trim())} /></Modal>;
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
