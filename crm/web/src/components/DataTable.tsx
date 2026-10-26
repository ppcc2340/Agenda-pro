/**
 * Tablero estilo monday con la libertad de una hoja de cálculo: celda activa, navegación con teclado, rangos,
 * copiar/pegar con Excel, rellenar, deshacer/rehacer, columnas redimensionables y reordenables, columnas
 * inmovilizadas, resúmenes en el pie, formato condicional y de número, y etiquetas editables dentro del propio
 * desplegable (también las del sistema, con etiquetas nuevas que «se comportan como» un estado base).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Filter, Download, Columns3, Save, ChevronUp, ChevronDown, X, Bookmark, ChevronDown as Caret, Plus, Trash2, Zap, Pencil, Palette, ArrowLeft, ArrowRight, EyeOff, Tag, Copy, FolderInput, Layers, Undo2, Redo2, Paintbrush, Hash, Repeat, Pin, Keyboard, Lock, Smartphone } from "lucide-react";
import { api, qs, downloadFile } from "../api";
import { FilterBuilder, describeFilters, type FilterGroup } from "./FilterBuilder";
import { Modal, Pager, Spinner, Empty, Field, useToast, useDebounce, errorMessage, Menu, Avatar, useConfirm } from "./ui";
import { useApp, type CustomField, type StatusLabel } from "../lib/app";
import { ColumnSettings } from "./ColumnSettings";
import { fmtMoney, fmtDate, fmtNum } from "../lib/format";
import { PALETTE, applyBoard, type Board } from "../lib/board";
import { BoardRules } from "./BoardRules";
import { onLive } from "../lib/live";
import { ColorPicker, LabelEditor, CondFormatDialog, NumFormatDialog, ChangeTypeDialog, Pop, TagsEditor, LongTextEditor, RangeEditor, RelationPicker, SHORTCUTS, type LabelItem, type LabelCaps } from "./GridDialogs";
import { norm, parseNumber, parseDate, parseBool, parseTSV, toTSV, fmtIsoDate, formatNumber, ruleMatches, SUMMARY_FNS, summaryKind, numericStats, fillSeries, type CondRule, type NumFormat } from "../lib/grid";
import { pillStyle, readable } from "../lib/colors";
import { t } from "../lib/i18n";

export { ColorPicker };
export type ColumnType = "text" | "name" | "status" | "person" | "money" | "number" | "date" | "tags" | "check" | "longtext" | "datetime" | "timeline" | "relation";
export interface StatusOption { label: string; color: string; base?: string; hidden?: boolean }
export interface Column<T> {
  key: string; label: string; render?: (row: T) => ReactNode; sortable?: boolean; className?: string; default?: boolean; width?: number;
  type?: ColumnType;
  options?: Record<string, StatusOption>;
  value?: (row: T) => unknown;
  onEdit?: (row: T, value: unknown) => Promise<unknown> | unknown;
  agg?: "sum" | "avg" | "none";
  sub?: (row: T) => ReactNode;
  /** set when the column is a custom field (allows deleting / editing options) */
  custom?: CustomField;
  /** built-in status columns whose option set belongs to the CRM (labels/colours editable, new labels «behave like» one) */
  fixedOptions?: boolean;
  /** writable field id (cells API): enables paste, fill, clear and undo in bulk */
  field?: string;
  /** converts the editor value into the stored field value */
  out?: (v: unknown) => unknown;
  /** base field for board-added labels (set by applyBoard) */
  extraOf?: string;
  /** custom label editor (e.g. pipeline stages) */
  saveLabels?: (items: LabelItem[], removed: LabelItem[]) => Promise<void>;
  relation?: { endpoint: string; labelOf: (r: Record<string, unknown>) => string };
  readOnlyReason?: string;
}
export interface Group { key: string; label: string; color: string }
export interface GroupOption<T> {
  key: string; label: string;
  get: (row: T) => string;
  groups: Group[];
  setValue?: (row: T, groupKey: string) => Promise<void> | void;
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
  /** creates a row; returning the created record lets a paste fill its other columns */
  onCreate?: (name: string, extra: Record<string, unknown>) => Promise<unknown> | unknown;
  onDuplicate?: (row: T) => Promise<void> | void;
  onDelete?: (ids: string[]) => Promise<void> | void;
}

type Pos = { r: string; c: string };
type Move = "down" | "up" | "right" | "left" | null;
interface UndoCell { rowId: string; colKey: string; before: unknown; after: unknown }
interface UndoStep { label: string; cells: UndoCell[] }

const EMPTY: FilterGroup = { logic: "and", conditions: [] };
/** Columna → campo que protege (las columnas de nombre derivan de su id). */
const ALIAS_FIELD: Record<string, string> = { owner_name: "owner_id", assignee_name: "assignee_id", legal_owner_name: "legal_owner_id", company_name: "company_id", counterparty_name: "counterparty_company_id", contact_name: "contact_id", stage_name: "stage_id", weighted_amount: "amount", pipeline_name: "pipeline_id", type_name: "type_id" };
export const fieldOfColumn = (k: string) => ALIAS_FIELD[k] ?? k;
const getPath = (row: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);
const DEFAULT_W: Record<string, number> = { name: 280, status: 140, person: 110, money: 130, number: 110, date: 120, datetime: 150, tags: 180, check: 80, longtext: 220, timeline: 170, relation: 170, text: 160 };
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);
const colType = <T,>(c: Column<T>, i: number): ColumnType => c.type ?? (i === 0 ? "name" : "text");

/** true por debajo de 720 px: la tabla pasa a lista de tarjetas. */
function useNarrow(q = "(max-width: 720px)") {
  const [m, setM] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => { const mq = window.matchMedia?.(q); if (!mq) return; const h = () => setM(mq.matches); mq.addEventListener("change", h); return () => mq.removeEventListener("change", h); }, [q]);
  return m;
}

export function DataTable<T extends { id: string }>({ object, endpoint, columns: rawColumns, board, onRowClick, toolbar, bulkActions, exportUrl, extraParams, refreshKey, emptyText, defaultSort, groupOptions, defaultGroup, onNew, newLabel, onCreate, onDuplicate, onDelete }: Props<T>) {
  const { me, refresh, can, users, access } = useApp();
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
  const [rules, setRules] = useState(false);
  const [renaming, setRenaming] = useState<Column<T> | null>(null);
  const [condOpen, setCondOpen] = useState(false);
  const [fmtFor, setFmtFor] = useState<Column<T> | null>(null);
  const [typeFor, setTypeFor] = useState<CustomField | null>(null);
  const [help, setHelp] = useState(false);
  const [labelPop, setLabelPop] = useState<{ col: Column<T>; at: { x: number; y: number } } | null>(null);
  // ---- grid state ----
  const [active, setActive] = useState<Pos | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ r: string; c: string; seed?: string } | null>(null);
  useEffect(() => { editingRef.current = !!editing; });
  const [fillTo, setFillTo] = useState<number | null>(null);
  const [resize, setResize] = useState<{ key: string; w: number } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selecting = useRef(false);
  const filling = useRef(false);
  const undoStack = useRef<UndoStep[]>([]);
  const redoStack = useRef<UndoStep[]>([]);
  const [, setUndoTick] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const canEdit = can(object, "update");
  const cfg = board.config;
  const narrow = useNarrow();

  // seguridad por campo: las columnas ocultas para el rol no aparecen y las de solo lectura llevan candado
  const columns = useMemo(() => applyBoard(rawColumns, board).flatMap((c) => {
    const f = fieldOfColumn(c.field ?? c.key);
    const a = access(object, f);
    if (a === "hidden") return [];
    return a === "read" ? [{ ...c, onEdit: undefined, field: undefined, readOnlyReason: "Campo de solo lectura para tu rol" }] : [c];
  }), [rawColumns, board.config, access, object]); // eslint-disable-line react-hooks/exhaustive-deps
  const [visible, setVisible] = useState<string[] | null>(() => { try { const s = localStorage.getItem(storageKey); if (s) return JSON.parse(s); } catch { /* ignore */ } return null; });
  const visibleKeys = useMemo(() => visible ?? columns.filter((c) => c.default !== false).map((c) => c.key), [visible, columns]);

  const loadViews = () => api.get<{ items: SavedView[] }>(`views?object=${object}`).then((r) => setViews(r.items)).catch(() => undefined);
  useEffect(() => { loadViews(); /* eslint-disable-next-line */ }, [object]);
  useEffect(() => { if (viewId && views.length) { const v = views.find((x) => x.id === viewId); if (v) { setFilters(v.filters?.conditions ? v.filters : EMPTY); if (v.columns?.length) setVisible(v.columns); if (v.sort?.field) setSort({ field: v.sort.field, dir: (v.sort.dir as "asc") ?? "desc" }); } } /* eslint-disable-next-line */ }, [viewId, views.length]);
  useEffect(() => { setPage(1); }, [dq, filters, sort]);
  const load = (silent = false) => {
    if (!silent) setLoading(true);
    return api.get<{ items: T[]; total: number }>(`${endpoint}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, page, page_size: pageSize, ...(extraParams ?? {}) })}`)
      .then((r) => {
        // al guardar, las filas no saltan de sitio (como en una hoja de cálculo); el orden se recalcula al recargar u ordenar
        if (silent) setData((prev) => { if (!prev) return r; const pos = new Map(prev.items.map((x, i) => [x.id, i])); const items = [...r.items].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)); return { ...r, items }; });
        else { setData(r); setSel([]); }
        return r;
      })
      .catch((e) => { toast(errorMessage(e), "error"); return null; })
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

  // cambios hechos por otras personas o por automatizaciones: recarga silenciosa (sin mover filas ni perder la edición)
  const editingRef = useRef(false);
  useEffect(() => onLive((e) => {
    if (e.object !== object || e.actor === me.id) return;
    window.clearTimeout(liveTimer.current); liveTimer.current = window.setTimeout(() => { if (!editingRef.current) load(true); }, 600);
  }), [object, me.id, dq, filters, sort, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveTimer = useRef<number | undefined>(undefined);
  const cols = useMemo(() => columns.filter((c) => visibleKeys.includes(c.key)), [columns, visibleKeys]);
  const saveCols = (v: string[]) => { setVisible(v); localStorage.setItem(storageKey, JSON.stringify(v)); };
  const applyView = (v: SavedView | null) => { setViewId(v?.id ?? null); if (!v) { setFilters(EMPTY); } };
  const deleteView = async (v: SavedView) => { await api.del(`views/${v.id}`); toast("Vista borrada", "ok"); if (viewId === v.id) applyView(null); loadViews(); };
  const exportCsv = async () => { try { await downloadFile(`/api/${exportUrl}${qs({ q: dq, filters: filters.conditions.length ? filters : undefined, sort: sort.field, dir: sort.dir, ...(extraParams ?? {}) })}`); toast("Exportación descargada", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const currentView = views.find((v) => v.id === viewId);
  const clearSel = () => { setSel([]); setTick((t) => t + 1); };
  const reload = () => setTick((t) => t + 1);

  // ---- board column config helpers ----
  const setColCfg = (key: string, patch: { label?: string; width?: number; hidden?: boolean }) => board.update((c) => { const cs = [...(c.columns ?? [])]; const i = cs.findIndex((x) => x.key === key); if (i >= 0) cs[i] = { ...cs[i]!, ...patch }; else cs.push({ key, ...patch }); return { ...c, columns: cs }; });
  const moveColTo = (key: string, target: string) => { const order = columns.map((c) => c.key).filter((k) => k !== key); const j = order.indexOf(target); order.splice(j < 0 ? order.length : j, 0, key); board.update((c) => ({ ...c, order })); };
  const moveCol = (key: string, dir: -1 | 1) => { const order = columns.map((c) => c.key); const i = order.indexOf(key); const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j]!, order[i]!]; board.update((c) => ({ ...c, order })); };
  const deleteCustom = async (c: Column<T>) => {
    if (!c.custom) return;
    if (!(await confirm({ title: `¿Borrar la columna «${c.label}»?`, text: "Se eliminará el campo y sus valores en todos los registros.", danger: true, confirmText: "Borrar" }))) return;
    try { await api.del(`admin/custom-fields/${c.custom.id}`); }
    catch (e) { const deps = (e as { body?: { dependents?: unknown[] } }).body?.dependents; if (!deps || !(await confirm({ title: "Otras columnas o automatizaciones la usan", text: errorMessage(e), danger: true, confirmText: "Borrar igualmente" }))) { if (!deps) toast(errorMessage(e), "error"); return; } await api.del(`admin/custom-fields/${c.custom.id}?force=1`); }
    toast("Columna borrada", "ok"); await refresh(); reload();
  };

  // ---- grouping ----
  const groupKey = cfg.group_by === undefined ? (defaultGroup ?? groupOptions?.[0]?.key ?? null) : cfg.group_by;
  const go = groupOptions?.find((g) => g.key === groupKey) ?? null;
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    if (!go) return [{ key: "all", label: "", color: "var(--c-blue)", rows: items, hidden: false }];
    const ov = cfg.groups?.[go.key] ?? {};
    const order = cfg.group_order?.[go.key];
    const map = new Map<string, T[]>();
    for (const r of items) { const k = go.get(r); map.set(k, [...(map.get(k) ?? []), r]); }
    let defs = go.groups.map((g) => ({ ...g, label: ov[g.key]?.label ?? g.label, color: ov[g.key]?.color ?? g.color, hidden: !!ov[g.key]?.hidden, rows: map.get(g.key) ?? [] }));
    if (order) defs = [...defs].sort((a, b) => { const ia = order.indexOf(a.key), ib = order.indexOf(b.key); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
    const known = new Set(go.groups.map((g) => g.key));
    const rest = items.filter((r) => !known.has(go.get(r)));
    if (rest.length) defs.push({ key: "__other", label: go.other ?? "Otros", color: "var(--c-grey)", hidden: false, rows: rest });
    return defs.filter((g) => !g.hidden && (g.rows.length > 0 || (!dq && filters.conditions.length === 0)));
  }, [data, go, cfg, dq, filters]);
  const setGroupCfg = (gk: string, patch: { label?: string; color?: string; hidden?: boolean }) => { if (!go) return; board.update((c) => ({ ...c, groups: { ...(c.groups ?? {}), [go.key]: { ...(c.groups?.[go.key] ?? {}), [gk]: { ...(c.groups?.[go.key]?.[gk] ?? {}), ...patch } } } })); };
  const moveGroup = (gk: string, dir: -1 | 1) => { if (!go) return; const order = groups.map((g) => g.key); const i = order.indexOf(gk); const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j]!, order[i]!]; board.update((c) => ({ ...c, group_order: { ...(c.group_order ?? {}), [go.key]: order } })); };
  const moveRow = async (row: T, gk: string) => { if (!go?.setValue) return; try { await go.setValue(row, gk); load(true); toast("Movido", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const create = async (name: string, gk: string) => { if (!onCreate || !name.trim()) return; try { await onCreate(name.trim(), go?.createValue?.(gk) ?? {}); load(true); toast("Creado", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const duplicate = async (row: T) => { if (!onDuplicate) return; try { await onDuplicate(row); load(true); toast("Duplicado", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };

  // ---- values ----
  const types = useMemo(() => new Map(cols.map((c, i) => [c.key, colType(c, i)])), [cols]);
  const typeOf = (c: Column<T>) => types.get(c.key) ?? colType(c, 1);
  const rawVal = (c: Column<T>, row: T) => (c.value ? c.value(row) : getPath(row, c.key));
  /** value in the editor's domain (option key, user id, ISO date, number…) */
  const editorVal = (c: Column<T>, row: T): unknown => { const t = typeOf(c); if ((t === "person" || t === "relation") && c.field) return getPath(row, c.field) ?? null; return rawVal(c, row) ?? null; };
  const isEditable = (c: Column<T>) => canEdit && !c.readOnlyReason && (!!c.onEdit || !!c.field);
  const textOf = (c: Column<T>, row: T): string => {
    const v = rawVal(c, row); const t = typeOf(c);
    if (isEmpty(v)) return "";
    switch (t) {
      case "status": return c.options?.[String(v)]?.label ?? String(v);
      case "check": return v === true || v === 1 || v === "true" ? "Sí" : "No";
      case "money": case "number": { const n = parseNumber(v); return n === null ? String(v) : String(n).replace(".", ","); }
      case "date": return fmtIsoDate(v);
      case "tags": return Array.isArray(v) ? v.join(", ") : String(v);
      case "timeline": { const o = v as { from?: string; to?: string }; return `${fmtIsoDate(o.from)} – ${fmtIsoDate(o.to)}`; }
      default: return typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  };

  // ---- conditional formats ----
  const condRules: CondRule[] = (cfg.cond_formats ?? []).filter((r) => r.enabled !== false);
  const condFor = (row: T): { row?: React.CSSProperties; cells: Record<string, React.CSSProperties> } => {
    const out: { row?: React.CSSProperties; cells: Record<string, React.CSSProperties> } = { cells: {} };
    for (const r of condRules) {
      const c = columns.find((x) => x.key === r.column); if (!c) continue;
      const t = types.get(c.key) ?? colType(c, columns.indexOf(c));
      if (!ruleMatches(r, t === "status" || t === "person" ? rawVal(c, row) : editorVal(c, row), t, textOf(c, row))) continue;
      const st: React.CSSProperties = { background: r.bg || undefined, color: r.color || undefined, fontWeight: r.bold ? 700 : undefined };
      if (r.scope === "row") { if (!out.row) out.row = st; } else if (!out.cells[c.key]) out.cells[c.key] = st;
    }
    return out;
  };

  // ---- flat row order (for keyboard, ranges, paste) ----
  const flat = useMemo(() => groups.filter((g) => !collapsed[g.key]).flatMap((g) => g.rows), [groups, collapsed]);
  const rowIdx = useMemo(() => new Map(flat.map((r, i) => [r.id, i])), [flat]);
  const colIdx = useMemo(() => new Map(cols.map((c, i) => [c.key, i])), [cols]);
  const rangeOf = useCallback(() => {
    if (!active) return null;
    const a = anchor ?? active;
    const r1 = rowIdx.get(a.r), r2 = rowIdx.get(active.r), c1 = colIdx.get(a.c), c2 = colIdx.get(active.c);
    if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return null;
    return { r0: Math.min(r1, r2), r1: Math.max(r1, r2), c0: Math.min(c1, c2), c1: Math.max(c1, c2) };
  }, [active, anchor, rowIdx, colIdx]);
  const rng = rangeOf();
  useEffect(() => { if (active && (!rowIdx.has(active.r) || !colIdx.has(active.c))) { setActive(null); setAnchor(null); setEditing(null); } }, [rowIdx, colIdx, active]);

  // ---- writing cells (single edits, paste, fill, clear, undo) ----
  const commit = async (changes: { row: T; col: Column<T>; value: unknown }[], opts: { label: string; undo?: boolean; quiet?: boolean } = { label: "Edición" }) => {
    const batch: { id: string; column_id: string; value: unknown }[] = [];
    const seq: (() => Promise<unknown>)[] = [];
    const cells: UndoCell[] = [];
    const single = changes.length === 1;
    for (const ch of changes) {
      const c = ch.col, row = ch.row;
      if (!isEditable(c)) continue;
      const before = editorVal(c, row);
      if (same(before, ch.value)) continue;
      cells.push({ rowId: row.id, colKey: c.key, before, after: ch.value });
      if (c.extraOf) {
        const opt = c.options?.[String(ch.value ?? "")];
        const hadSub = !!getPath(row, `custom._lbl_${c.extraOf}`);
        if (opt?.base) { batch.push({ id: row.id, column_id: c.extraOf, value: opt.base }, { id: row.id, column_id: `custom._lbl_${c.extraOf}`, value: ch.value }); continue; }
        if (single && c.onEdit) seq.push(async () => c.onEdit!(row, ch.value)); else batch.push({ id: row.id, column_id: c.extraOf, value: ch.value });
        if (hadSub) batch.push({ id: row.id, column_id: `custom._lbl_${c.extraOf}`, value: null });
        continue;
      }
      if (single && c.onEdit) { seq.push(async () => c.onEdit!(row, ch.value)); continue; }
      if (c.field) batch.push({ id: row.id, column_id: c.field, value: c.out ? c.out(ch.value) : ch.value });
      else if (c.onEdit) seq.push(async () => c.onEdit!(row, ch.value));
    }
    if (!cells.length) return 0;
    if (single && cells[0]) { const c = changes[0]!.col; const t = typeOf(c); if (!c.value && t !== "person" && t !== "relation") setData((d) => d ? { ...d, items: d.items.map((r) => (r.id === cells[0]!.rowId ? setPath(r, c.key, changes[0]!.value) : r)) } : d); }
    setBusy(true);
    const errors: string[] = [];
    try {
      for (const f of seq) { try { await f(); } catch (e) { errors.push(errorMessage(e)); } }
      for (let i = 0; i < batch.length; i += 1000) {
        try { const r = await api.post<{ ok: number; errors: { error: string }[] }>(`cells/${object}/batch`, { changes: batch.slice(i, i + 1000) }); errors.push(...r.errors.map((x) => x.error)); } catch (e) { errors.push(errorMessage(e)); }
      }
    } finally { setBusy(false); }
    if (opts.undo !== false) { undoStack.current.push({ label: opts.label, cells }); if (undoStack.current.length > 100) undoStack.current.shift(); redoStack.current = []; setUndoTick((x) => x + 1); }
    await load(true);
    if (errors.length) toast(`${cells.length - errors.length} celdas actualizadas · ${errors.length} con error: ${Array.from(new Set(errors)).slice(0, 2).join(" · ")}`, "error");
    else if (!opts.quiet && cells.length > 1) toast(`${opts.label}: ${cells.length} celdas`, "ok");
    return cells.length;
  };
  const replay = async (from: "undo" | "redo") => {
    const stack = from === "undo" ? undoStack.current : redoStack.current;
    const step = stack.pop(); if (!step) return;
    const items = data?.items ?? [];
    const changes = step.cells.map((c) => ({ row: items.find((r) => r.id === c.rowId), col: columns.find((x) => x.key === c.colKey), value: from === "undo" ? c.before : c.after })).filter((x): x is { row: T; col: Column<T>; value: unknown } => !!x.row && !!x.col);
    await commit(changes, { label: step.label, undo: false, quiet: true });
    (from === "undo" ? redoStack.current : undoStack.current).push(step);
    setUndoTick((x) => x + 1);
    toast(`${from === "undo" ? "Deshecho" : "Rehecho"}: ${step.label.toLowerCase()}`, "ok");
  };

  // ---- reading pasted text into a column ----
  const fromText = (c: Column<T>, text: string): { ok: true; value: unknown } | { ok: false; unknown?: string; error?: string } => {
    const s = text.trim(); const t = typeOf(c);
    if (!s) return t === "check" ? { ok: true, value: false } : t === "status" && c.fixedOptions ? { ok: false, error: `${c.label} no puede quedar vacío` } : { ok: true, value: t === "tags" ? [] : null };
    switch (t) {
      case "money": case "number": { const n = parseNumber(s); return n === null ? { ok: false, error: `«${s}» no es un número` } : { ok: true, value: n }; }
      case "date": { const d = parseDate(s); return d ? { ok: true, value: d } : { ok: false, error: `«${s}» no es una fecha` }; }
      case "datetime": { const d = parseDate(s); return d ? { ok: true, value: s.length > 10 && /\d:\d/.test(s) ? new Date(s.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/, "$3-$2-$1")).toISOString() : d } : { ok: false, error: `«${s}» no es una fecha` }; }
      case "check": { const b = parseBool(s); return b === null ? { ok: false, error: `«${s}» no es sí/no` } : { ok: true, value: b }; }
      case "status": { const hit = Object.entries(c.options ?? {}).find(([k, o]) => k === s || norm(o.label) === norm(s)); return hit ? { ok: true, value: hit[0] } : { ok: false, unknown: s }; }
      case "person": { const u = users.find((x) => norm(x.name) === norm(s) || norm(x.email) === norm(s) || norm(x.name.split(/\s+/).map((p) => p[0]).join("")) === norm(s)); return u ? { ok: true, value: u.id } : { ok: false, error: `No hay ningún usuario «${s}»` }; }
      case "tags": return { ok: true, value: s.split(/\s*[,;|]\s*/).filter(Boolean) };
      case "timeline": { const [a, b] = s.split(/\s*[–-]{1,2}\s*(?=\d)|\s+a\s+/); const fa = parseDate(a), fb = parseDate(b ?? a); return fa ? { ok: true, value: { from: fa, to: fb ?? fa } } : { ok: false, error: `«${s}» no es un rango de fechas` }; }
      default: return { ok: true, value: s };
    }
  };
  const resolveRelation = async (c: Column<T>, text: string) => { if (!c.relation || !text.trim()) return null; const r = await api.get<{ items: Record<string, unknown>[] }>(`${c.relation.endpoint}?q=${encodeURIComponent(text.trim())}&page_size=5`); return r.items.find((x) => norm(c.relation!.labelOf(x)) === norm(text)) ?? r.items[0] ?? undefined; };

  // ---- labels ----
  const labelModel = (c: Column<T>): { items: LabelItem[]; caps: LabelCaps } | null => {
    if (c.custom?.type === "status") {
      const st = (c.custom.settings ?? {}) as { labels?: StatusLabel[]; label_set_id?: string };
      if (st.label_set_id) return { items: (st.labels ?? []).map((l) => ({ key: String(l.id), label: l.label, color: l.color, done: l.done, kind: "custom" })), caps: { canAdd: false, canDelete: () => false, canHide: false, newKind: "custom", note: "Usa un conjunto de etiquetas compartido: edítalo en Ajustes → Etiquetas para cambiarlo en todos los tableros." } };
      return { items: (st.labels ?? []).map((l) => ({ key: String(l.id), label: l.label, color: l.color, done: l.done, kind: "custom" })), caps: { canAdd: true, canDelete: () => true, canHide: false, hasDone: true, newKind: "custom", note: "Se guarda el ID de cada etiqueta: renombrar no toca los datos. No se puede quitar una etiqueta en uso." } };
    }
    if (c.custom && (c.custom.type === "select" || c.custom.type === "multiselect")) return { items: Object.entries(c.options ?? {}).map(([k, o]) => ({ key: k, label: o.label, color: o.color, kind: "custom" })), caps: { canAdd: true, canDelete: () => true, canHide: false, newKind: "custom", note: "Renombrar cambia solo cómo se ve. Para IDs estables, cambia el tipo de la columna a Estado." } };
    if (c.saveLabels) return { items: Object.entries(c.options ?? {}).map(([k, o]) => ({ key: k, label: o.label, color: o.color, kind: "stage" })), caps: { canAdd: true, canDelete: () => true, canHide: false, newKind: "stage", note: "Son las etapas del pipeline: los cambios se ven también en el kanban." } };
    if (c.type === "status" && c.options) {
      const opts = Object.entries(c.options);
      const bases = opts.filter(([, o]) => !o.base).map(([k, o]) => ({ key: k, label: o.label }));
      return { items: opts.map(([k, o]) => ({ key: k, label: o.label, color: o.color, hidden: o.hidden, kind: o.base ? "extra" : "builtin", base: o.base })), caps: { canAdd: !!c.extraOf, canDelete: (it) => it.kind === "extra", canHide: true, bases, newKind: "extra", note: c.extraOf ? "Las etiquetas del CRM no se borran (las usan informes y automatizaciones), pero puedes renombrarlas, recolorearlas, ordenarlas u ocultarlas. Las nuevas «se comportan como» la etiqueta que elijas." : "Puedes renombrar, recolorear, ordenar y ocultar estas etiquetas." } };
    }
    return null;
  };
  const saveLabels = async (c: Column<T>, items: LabelItem[], removed: LabelItem[]) => {
    try {
      if (c.custom?.type === "status") {
        const st = (c.custom.settings ?? {}) as Record<string, unknown>;
        await api.put(`admin/custom-fields/${c.custom.id}`, { settings: { ...st, labels: items.map((it) => ({ id: it.isNew ? 0 : Number(it.key), label: it.label, color: it.color, done: !!it.done })) } });
        await refresh();
      } else if (c.custom && (c.custom.type === "select" || c.custom.type === "multiselect")) {
        const options = items.map((it) => (it.isNew ? it.label : it.key));
        await api.put(`admin/custom-fields/${c.custom.id}`, { options });
        board.update((b) => ({ ...b, labels: { ...(b.labels ?? {}), [c.key]: Object.fromEntries(items.map((it) => [it.isNew ? it.label : it.key, { label: it.label, color: it.color }])) } }));
        await refresh();
      } else if (c.saveLabels) {
        await c.saveLabels(items, removed);
      } else {
        const ids = new Map<string, string>();
        const extras = items.filter((it) => it.kind === "extra").map((it) => { const id = it.isNew ? `x_${Math.random().toString(36).slice(2, 8)}` : it.key; ids.set(it.key, id); return { id, label: it.label, color: it.color, base: it.base ?? "" }; });
        board.update((b) => ({
          ...b,
          labels: { ...(b.labels ?? {}), [c.key]: Object.fromEntries(items.filter((it) => it.kind === "builtin").map((it) => [it.key, { label: it.label, color: it.color, hidden: !!it.hidden }])) },
          label_order: { ...(b.label_order ?? {}), [c.key]: items.map((it) => ids.get(it.key) ?? it.key) },
          ...(c.extraOf ? { extra_labels: { ...(b.extra_labels ?? {}), [c.extraOf]: extras } } : {}),
        }));
      }
      toast("Etiquetas guardadas", "ok"); reload();
      return true;
    } catch (e) { toast(errorMessage(e), "error"); return false; }
  };

  // ---- range operations ----
  const rangeCells = () => { const r = rangeOf(); if (!r) return []; const out: { row: T; col: Column<T>; ri: number; ci: number }[] = []; for (let ri = r.r0; ri <= r.r1; ri++) for (let ci = r.c0; ci <= r.c1; ci++) out.push({ row: flat[ri]!, col: cols[ci]!, ri, ci }); return out; };
  const copyText = () => { const r = rangeOf(); if (!r) return ""; const rows: string[][] = []; for (let ri = r.r0; ri <= r.r1; ri++) { const line: string[] = []; for (let ci = r.c0; ci <= r.c1; ci++) line.push(textOf(cols[ci]!, flat[ri]!)); rows.push(line); } return toTSV(rows); };
  const clearRange = async (label = "Vaciar") => {
    const cells = rangeCells().filter(({ col }) => isEditable(col) && typeOf(col) !== "name" && !(col.fixedOptions && typeOf(col) === "status"));
    if (!cells.length) return toast("No hay celdas editables que vaciar", "error");
    await commit(cells.map(({ row, col }) => ({ row, col, value: typeOf(col) === "check" ? false : typeOf(col) === "tags" ? [] : null })), { label });
  };
  const fillRange = async (toRow: number) => {
    const r = rangeOf(); if (!r) return;
    const changes: { row: T; col: Column<T>; value: unknown }[] = [];
    for (let ci = r.c0; ci <= r.c1; ci++) {
      const col = cols[ci]!; if (!isEditable(col)) continue;
      const seed = []; for (let ri = r.r0; ri <= r.r1; ri++) seed.push(editorVal(col, flat[ri]!));
      if (toRow > r.r1) { const vals = fillSeries(seed, toRow - r.r1, typeOf(col)); vals.forEach((v, k) => changes.push({ row: flat[r.r1 + 1 + k]!, col, value: v })); }
      else if (toRow < r.r0) { const n = r.r0 - toRow; for (let k = 1; k <= n; k++) changes.push({ row: flat[r.r0 - k]!, col, value: seed[(seed.length - (k % seed.length)) % seed.length] }); }
    }
    if (changes.length) await commit(changes, { label: "Rellenar" });
    const a = anchor ?? active; if (a && active) { const end = flat[toRow]; if (end) { setAnchor({ r: flat[Math.min(toRow, r.r0)]!.id, c: cols[r.c0]!.key }); setActive({ r: flat[Math.max(toRow, r.r1)]!.id, c: cols[r.c1]!.key }); } }
  };
  const fillDown = async () => {
    const r = rangeOf(); if (!r || r.r1 === r.r0) return toast("Selecciona varias filas: se copia la primera hacia abajo", "error");
    const changes: { row: T; col: Column<T>; value: unknown }[] = [];
    for (let ci = r.c0; ci <= r.c1; ci++) { const col = cols[ci]!; if (!isEditable(col)) continue; const v = editorVal(col, flat[r.r0]!); for (let ri = r.r0 + 1; ri <= r.r1; ri++) changes.push({ row: flat[ri]!, col, value: v }); }
    await commit(changes, { label: "Rellenar hacia abajo" });
  };
  const paste = async (text: string) => {
    if (!active) return;
    let grid = parseTSV(text); if (!grid.length) return;
    if (grid.length > 1 && grid[grid.length - 1]!.every((x) => x === "")) grid = grid.slice(0, -1);
    const r = rangeOf()!; const startR = r.r0, startC = r.c0;
    // un solo valor sobre un rango: se repite en todo el rango (como Excel)
    if (grid.length === 1 && grid[0]!.length === 1 && (r.r1 > r.r0 || r.c1 > r.c0)) grid = Array.from({ length: r.r1 - r.r0 + 1 }, () => Array.from({ length: r.c1 - r.c0 + 1 }, () => grid[0]![0]!));
    const changes: { row: T; col: Column<T>; value: unknown }[] = [];
    const errors: string[] = []; const unknown = new Map<string, Set<string>>();
    const parsed: { row: T | null; col: Column<T>; text: string; ri: number }[] = [];
    let overflow = 0;
    grid.forEach((line, i) => { const row = flat[startR + i] ?? null; if (!row) overflow++; line.forEach((txt, j) => { const col = cols[startC + j]; if (col) parsed.push({ row, col, text: txt, ri: i }); }); });
    // etiquetas nuevas en columnas de estado propias: se pueden crear al vuelo
    for (const p of parsed) { if (typeOf(p.col) !== "status") continue; const f = fromText(p.col, p.text); if (!f.ok && f.unknown) { if (!unknown.has(p.col.key)) unknown.set(p.col.key, new Set()); unknown.get(p.col.key)!.add(f.unknown); } }
    const created = new Map<string, Record<string, string>>();
    for (const [ck, set] of unknown) {
      const col = cols.find((c) => c.key === ck)!;
      const model = labelModel(col);
      const creatable = col.custom && (col.custom.type === "status" || col.custom.type === "select") && model?.caps.canAdd;
      if (!creatable) continue;
      if (!(await confirm({ title: `¿Crear ${set.size} etiqueta(s) nueva(s) en «${col.label}»?`, text: Array.from(set).join(", "), confirmText: "Crear" }))) continue;
      const items: LabelItem[] = [...model!.items, ...Array.from(set).map((label, i) => ({ key: `new_${i}`, label, color: PALETTE[(model!.items.length + i) * 3 % PALETTE.length]!, kind: "custom" as const, isNew: true }))];
      if (col.custom!.type === "status") {
        const st = (col.custom!.settings ?? {}) as Record<string, unknown>;
        const res = await api.put<CustomField>(`admin/custom-fields/${col.custom!.id}`, { settings: { ...st, labels: items.map((it) => ({ id: it.isNew ? 0 : Number(it.key), label: it.label, color: it.color, done: !!it.done })) } });
        created.set(ck, Object.fromEntries(((res.settings?.labels as StatusLabel[]) ?? []).map((l) => [norm(l.label), String(l.id)])));
      } else { await api.put(`admin/custom-fields/${col.custom!.id}`, { options: items.map((it) => (it.isNew ? it.label : it.key)) }); created.set(ck, Object.fromEntries(Array.from(set).map((x) => [norm(x), x]))); }
    }
    if (created.size) await refresh();
    // filas nuevas si lo pegado no cabe
    const newRows: (T | null)[] = [];
    if (overflow > 0) {
      const nameCol = cols[startC] && typeOf(cols[startC]!) === "name" ? cols[startC]! : null;
      if (onCreate && nameCol && canEdit && await confirm({ title: `Lo pegado tiene ${overflow} fila(s) más que la tabla`, text: "¿Crear elementos nuevos con esas filas?", confirmText: `Crear ${overflow}` })) {
        const gk = go ? (go.get(flat[flat.length - 1] ?? ({} as T)) || go.groups[0]?.key || "") : "";
        for (let i = grid.length - overflow; i < grid.length; i++) { const name = grid[i]![0]?.trim(); if (!name) { newRows.push(null); continue; } try { const res = await onCreate(name, go?.createValue?.(gk) ?? {}); newRows.push(res && typeof res === "object" && "id" in res ? (res as T) : null); } catch (e) { errors.push(errorMessage(e)); newRows.push(null); } }
      }
    }
    for (const p of parsed) {
      const row = p.row ?? newRows[p.ri - (grid.length - overflow)] ?? null; if (!row) continue;
      if (!p.row && typeOf(p.col) === "name") continue;
      if (!isEditable(p.col)) { if (p.text.trim() && textOf(p.col, row) !== p.text.trim()) errors.push(`«${p.col.label}» es de solo lectura`); continue; }
      if (typeOf(p.col) === "relation") { try { const hit = await resolveRelation(p.col, p.text); if (hit === undefined) errors.push(`No se encontró «${p.text}»`); else changes.push({ row, col: p.col, value: hit ? hit.id : null }); } catch (e) { errors.push(errorMessage(e)); } continue; }
      const made = created.get(p.col.key)?.[norm(p.text)];
      const f = made ? { ok: true as const, value: made } : fromText(p.col, p.text);
      if (f.ok) changes.push({ row, col: p.col, value: f.value }); else errors.push(f.error ?? `«${f.unknown}» no es una etiqueta de ${p.col.label}`);
    }
    if (changes.length) await commit(changes, { label: "Pegar", quiet: !!errors.length });
    else if (newRows.length) await load(true);
    if (errors.length) toast(`${changes.length} celdas pegadas · ${errors.length} no se pudieron leer: ${Array.from(new Set(errors)).slice(0, 2).join(" · ")}`, "error");
    const endR = Math.min(startR + grid.length - 1, flat.length - 1 + newRows.filter(Boolean).length), endC = Math.min(startC + Math.max(...grid.map((l) => l.length)) - 1, cols.length - 1);
    if (flat[endR] && cols[endC]) { setAnchor({ r: flat[startR]!.id, c: cols[startC]!.key }); setActive({ r: flat[endR]!.id, c: cols[endC]!.key }); }
  };

  // ---- keyboard ----
  const go2 = (ri: number, ci: number, extend: boolean) => {
    const r = Math.max(0, Math.min(flat.length - 1, ri)), c = Math.max(0, Math.min(cols.length - 1, ci));
    const row = flat[r], col = cols[c]; if (!row || !col) return;
    const pos = { r: row.id, c: col.key };
    if (extend) { if (!anchor) setAnchor(active); } else setAnchor(null);
    setActive(pos);
  };
  const startEdit = (pos: Pos, seed?: string) => {
    const col = cols.find((c) => c.key === pos.c); if (!col) return;
    if (!isEditable(col)) { toast(col.readOnlyReason ?? `«${col.label}» se calcula o es de solo lectura`, "error"); return; }
    const t = typeOf(col);
    if (t === "check") { const row = flat[rowIdx.get(pos.r) ?? -1]; if (row) commit([{ row, col, value: !(editorVal(col, row) === true || editorVal(col, row) === 1) }], { label: "Casilla" }); return; }
    setEditing({ ...pos, seed: seed !== undefined && ["text", "name", "number", "money", "date", "datetime"].includes(t) ? seed : undefined });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !active) return;
    const target = e.target as HTMLElement;
    if (target !== gridRef.current && target.closest("input,textarea,select,[contenteditable]")) return;
    const ri = rowIdx.get(active.r) ?? 0, ci = colIdx.get(active.c) ?? 0;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); replay(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && k.toLowerCase() === "y") { e.preventDefault(); replay("redo"); return; }
    if (mod && k.toLowerCase() === "d") { e.preventDefault(); fillDown(); return; }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); if (flat.length && cols.length) { setAnchor({ r: flat[0]!.id, c: cols[0]!.key }); setActive({ r: flat[flat.length - 1]!.id, c: cols[cols.length - 1]!.key }); } return; }
    if (mod) return; // copiar/cortar/pegar llegan como eventos del portapapeles
    const nav: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
    if (nav[k]) { e.preventDefault(); const [dr, dc] = nav[k]!; go2(ri + dr, ci + dc, e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); go2(ri, ci + (e.shiftKey ? -1 : 1), false); return; }
    if (k === "Home") { e.preventDefault(); go2(ri, 0, e.shiftKey); return; }
    if (k === "End") { e.preventDefault(); go2(ri, cols.length - 1, e.shiftKey); return; }
    if (k === "Enter" || k === "F2") { e.preventDefault(); if (rng && (rng.r0 !== rng.r1 || rng.c0 !== rng.c1) && k === "Enter") { go2(ri + (e.shiftKey ? -1 : 1), ci, false); return; } startEdit(active); return; }
    if (k === " ") { e.preventDefault(); startEdit(active); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearRange(); return; }
    if (k === "Escape") { setAnchor(null); return; }
    if (k.length === 1 && !e.altKey) { e.preventDefault(); startEdit(active, k); }
  };
  const afterEdit = (move: Move) => {
    setEditing(null);
    if (!active) return;
    const ri = rowIdx.get(active.r) ?? 0, ci = colIdx.get(active.c) ?? 0;
    if (move === "down") go2(ri + 1, ci, false); else if (move === "up") go2(ri - 1, ci, false); else if (move === "right") go2(ri, ci + 1, false); else if (move === "left") go2(ri, ci - 1, false);
    setTimeout(() => gridRef.current?.focus({ preventScroll: true }), 0);
  };
  const editCommit = async (row: T, col: Column<T>, value: unknown, move: Move) => { afterEdit(move); await commit([{ row, col, value }], { label: `Editar ${col.label}` }); };
  useEffect(() => {
    const up = () => { selecting.current = false; if (filling.current) { filling.current = false; setFillTo((to) => { if (to !== null) fillRange(to); return null; }); } };
    window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up);
    // eslint-disable-next-line
  });
  const clickEdit = useRef(false);
  const cellClick = (e: React.MouseEvent, row: T, col: Column<T>) => {
    if (e.shiftKey || (e.target as HTMLElement).closest("a,button,input,select,textarea,.cdd,.cpop")) return;
    const t = typeOf(col);
    if (anchor && (anchor.r !== row.id || anchor.c !== col.key)) return; // fin de un arrastre de selección
    if (t === "status" || t === "person" || clickEdit.current) { setAnchor(null); startEdit({ r: row.id, c: col.key }); }
  };
  const cellDown = (e: React.MouseEvent, row: T, col: Column<T>) => {
    if (e.button !== 0) return;
    const pos = { r: row.id, c: col.key };
    clickEdit.current = !e.shiftKey && active?.r === row.id && active.c === col.key && !editing;
    const interactive = (e.target as HTMLElement).closest("a,button,input,select,textarea,.cdd,.cpop");
    if (editing && editing.r === row.id && editing.c === col.key) return;
    if (editing) setEditing(null);
    if (e.shiftKey && active) { e.preventDefault(); if (!anchor) setAnchor(active); setActive(pos); }
    else { setActive(pos); if (!interactive) { selecting.current = true; setAnchor(pos); } else setAnchor(null); }
    if (!interactive) { e.preventDefault(); gridRef.current?.focus({ preventScroll: true }); }
  };
  const cellEnter = (row: T, col: Column<T>) => {
    if (filling.current) { const i = rowIdx.get(row.id); if (i !== undefined) setFillTo(i); return; }
    if (selecting.current) setActive({ r: row.id, c: col.key });
  };

  // ---- layout: widths, freeze ----
  const widthOf = (c: Column<T>) => (resize?.key === c.key ? resize.w : (cfg.columns?.find((x) => x.key === c.key)?.width ?? c.width ?? DEFAULT_W[typeOf(c)] ?? 150));
  const freeze = Math.min(cfg.freeze ?? 1, cols.length);
  const lead = 6 + (bulkActions ? 36 : 0);
  const lefts: number[] = []; { let x = lead; cols.forEach((c, i) => { lefts.push(x); if (i < freeze) x += widthOf(c); }); }
  const tableW = lead + cols.reduce((s, c) => s + widthOf(c), 0) + 44;
  const frz = (i: number): React.CSSProperties | undefined => (i < freeze ? { position: "sticky", left: lefts[i], zIndex: 2 } : undefined);
  const startResize = (e: React.MouseEvent, c: Column<T>) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = widthOf(c); let w = w0;
    const mv = (ev: MouseEvent) => { w = Math.max(60, Math.min(800, w0 + ev.clientX - x0)); setResize({ key: c.key, w }); };
    const upH = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", upH); setResize(null); if (w !== w0) setColCfg(c.key, { width: Math.round(w) }); };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", upH);
  };

  // ---- footer summaries ----
  const sumKey = (c: Column<T>) => cfg.summary?.[c.key] ?? (c.agg === "none" ? "none" : summaryKind(typeOf(c)) === "number" ? (c.agg === "avg" ? "avg" : "sum") : summaryKind(typeOf(c)) === "status" ? "dist" : summaryKind(typeOf(c)) === "check" ? "checked" : "none");
  const fmtFor_ = (c: Column<T>): NumFormat | undefined => cfg.num_formats?.[c.key];
  const showNum = (c: Column<T>, n: number) => { const f = fmtFor_(c); if (f) return formatNumber(n, f); return typeOf(c) === "money" ? fmtMoney(n) : fmtNum(Math.round(n * 100) / 100); };
  const footer = (c: Column<T>, rows: T[]): ReactNode => {
    const k = sumKey(c); if (k === "none") return null;
    const vals = rows.map((r) => (typeOf(c) === "status" ? rawVal(c, r) : editorVal(c, r)));
    const filled = vals.filter((v) => !isEmpty(v)).length;
    const pctFilled = rows.length ? Math.round((filled / rows.length) * 100) : 0;
    switch (k) {
      case "sum": case "avg": case "median": case "min": case "max": { const s = numericStats(vals); const v = s[k as "sum"]; return <><b>{showNum(c, v)}</b>{SUMMARY_FNS.number!.find((x) => x.key === k)!.label.toLowerCase()}</>; }
      case "count": return <><b>{filled}</b>recuento</>;
      case "empty": return <><b>{rows.length - filled}</b>vacíos</>;
      case "filled": return <><b>{pctFilled} %</b>lleno</>;
      case "unique": return <><b>{new Set(vals.filter((v) => !isEmpty(v)).map((v) => JSON.stringify(v))).size}</b>únicos</>;
      case "checked": { const n = vals.filter((v) => v === true || v === 1 || v === "true").length; return <span className="small sub">{n}/{rows.length}</span>; }
      case "pct": { const n = vals.filter((v) => v === true || v === 1 || v === "true").length; return <><b>{rows.length ? Math.round((n / rows.length) * 100) : 0} %</b>marcadas</>; }
      case "earliest": case "latest": case "range": { const ds = vals.map((v) => parseDate(v)).filter((d): d is string => !!d).sort(); if (!ds.length) return null; const e = fmtDate(ds[0]!, { day: "2-digit", month: "short" }), l = fmtDate(ds[ds.length - 1]!, { day: "2-digit", month: "short" }); return <span className="small sub">{k === "earliest" ? e : k === "latest" ? l : `${e} – ${l}`}</span>; }
      case "dist": case "counts": {
        const counts = new Map<string, number>(); vals.forEach((v) => { const key = String(v ?? ""); counts.set(key, (counts.get(key) ?? 0) + 1); });
        if (k === "counts") return <span className="xs" style={{ whiteSpace: "normal", lineHeight: 1.3 }}>{Array.from(counts).map(([key, n]) => `${c.options?.[key]?.label ?? (key || "—")} ${n}`).join(" · ")}</span>;
        return <div className="dist" title={Array.from(counts).map(([key, n]) => `${c.options?.[key]?.label ?? (key || "vacío")}: ${n}`).join(" · ")}>{Array.from(counts).map(([key, n]) => <i key={key} style={{ width: `${(n / rows.length) * 100}%`, background: c.options?.[key]?.color ?? "var(--c-grey)" }} />)}</div>;
      }
      default: return null;
    }
  };
  const setSummary = (c: Column<T>, k: string) => board.update((b) => ({ ...b, summary: { ...(b.summary ?? {}), [c.key]: k } }));

  // ---- status bar for the selection ----
  const statusBar = (() => {
    if (!rng || (rng.r0 === rng.r1 && rng.c0 === rng.c1)) return null;
    const vals: unknown[] = []; let filled = 0; let numericCol = false;
    for (let ri = rng.r0; ri <= rng.r1; ri++) for (let ci = rng.c0; ci <= rng.c1; ci++) { const c = cols[ci]!; const v = editorVal(c, flat[ri]!); if (!isEmpty(v)) filled++; if (["money", "number"].includes(typeOf(c))) { numericCol = true; vals.push(v); } }
    const s = numericStats(vals);
    return { cells: (rng.r1 - rng.r0 + 1) * (rng.c1 - rng.c0 + 1), filled, s: numericCol && s.n ? s : null };
  })();

  // ---- header menu ----
  const headerMenu = (c: Column<T>, i: number) => {
    const ct = typeOf(c); const lm = labelModel(c);
    return (
      <Menu fixed trigger={<button className="th-menu" aria-label={`${t("grid.colOptions")}: ${c.label}`}><Caret size={13} /></button>}>
        {c.sortable && <button onClick={() => setSort({ field: c.key, dir: "asc" })}><ChevronUp />Ordenar ascendente</button>}
        {c.sortable && <button onClick={() => setSort({ field: c.key, dir: "desc" })}><ChevronDown />Ordenar descendente</button>}
        {canEdit && <button onClick={() => setRenaming(c)}><Pencil />Renombrar</button>}
        {canEdit && lm && <button onClick={(e) => { const r = (e.currentTarget.closest("th") as HTMLElement | null)?.getBoundingClientRect(); setLabelPop({ col: c, at: { x: r?.left ?? 200, y: (r?.bottom ?? 100) + 4 } }); }}><Tag />Editar etiquetas</button>}
        {canEdit && <button onClick={() => setFmtFor(c)}><Hash />Formato…</button>}
        {canEdit && c.custom && !["formula", "mirror", "autonumber", "creation_log", "last_updated", "button"].includes(c.custom.type) && <button onClick={() => setTypeFor(c.custom!)}><Repeat />Cambiar tipo…</button>}
        {canEdit && c.custom && ["formula", "mirror"].includes(c.custom.type) && <button onClick={() => setTypeFor(c.custom!)}><Repeat />Convertir en valores…</button>}
        {canEdit && <button onClick={() => board.update((b) => ({ ...b, freeze: freeze === i + 1 ? 0 : i + 1 }))}><Pin />{freeze === i + 1 ? "Desinmovilizar" : "Inmovilizar hasta aquí"}</button>}
        {canEdit && <button onClick={() => moveCol(c.key, -1)}><ArrowLeft />Mover a la izquierda</button>}
        {canEdit && <button onClick={() => moveCol(c.key, 1)}><ArrowRight />Mover a la derecha</button>}
        {canEdit && (cfg.columns?.find((x) => x.key === c.key)?.width) && <button onClick={() => board.update((b) => ({ ...b, columns: (b.columns ?? []).map((x) => (x.key === c.key ? { ...x, width: undefined } : x)) }))}><Columns3 />Ancho automático</button>}
        <button onClick={() => saveCols(visibleKeys.filter((k) => k !== c.key))}><EyeOff />Ocultar columna</button>
        {canEdit && c.custom && <button onClick={() => deleteCustom(c)} style={{ color: "var(--risk-ink)" }}><Trash2 />Borrar columna</button>}
        {ct === "status" && <span className="xs muted" style={{ display: "block", padding: "4px 10px" }}>Haz clic en una etiqueta y pulsa «Editar etiquetas» para cambiarlas ahí mismo.</span>}
      </Menu>
    );
  };

  const undoN = undoStack.current.length, redoN = redoStack.current.length;
  const mobileKeys = (cfg.mobile_fields ?? cols.filter((c) => typeOf(c) !== "name").slice(0, 3).map((c) => c.key)).filter((k) => cols.some((c) => c.key === k));
  return (
    <div>
      <div className="filterbar">
        {onNew && <button className="btn primary" onClick={onNew}><Plus />{newLabel ?? t("grid.new")}</button>}
        <input className="input" style={{ maxWidth: 220 }} placeholder={t("grid.search")} aria-label={t("grid.search")} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        <Menu trigger={<button className="btn ghost"><Bookmark />{currentView ? currentView.name : t("grid.all")}<ChevronDown /></button>}>
          <button onClick={() => applyView(null)}>{t("grid.allRecords")}</button>
          {views.length > 0 && <div className="sep" />}
          {views.map((v) => <button key={v.id} onClick={() => applyView(v)} style={{ fontWeight: v.id === viewId ? 700 : 400 }}>{v.name}{v.shared ? <span className="badge xs right">compartida</span> : null}{(v.user_id === me.id || me.role.permissions.admin) && <span className="iconbtn" style={{ width: 20, height: 20, marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); deleteView(v); }} title="Borrar vista"><X size={12} /></span>}</button>)}
        </Menu>
        <button className={`btn ghost ${filters.conditions.length ? "on" : ""}`} onClick={() => setShowFilters(true)}><Filter />{t("grid.filters")}{filters.conditions.length ? ` (${filters.conditions.length})` : ""}</button>
        {filters.conditions.length > 0 && <button className="btn ghost sm" onClick={() => { setFilters(EMPTY); setViewId(null); }}><X />{t("grid.clear")}</button>}
        {groupOptions && groupOptions.length > 0 && (
          <Menu trigger={<button className="btn ghost"><Layers />{go ? t("grid.group", { col: columns.find((c) => c.key === go.key)?.label ?? go.label }) : t("grid.noGroup")}<ChevronDown /></button>}>
            <button onClick={() => board.update({ group_by: null })} style={{ fontWeight: !go ? 700 : 400 }}>{t("grid.noGroup")}</button>
            <div className="sep" />
            {groupOptions.map((g) => <button key={g.key} onClick={() => board.update({ group_by: g.key })} style={{ fontWeight: go?.key === g.key ? 700 : 400 }}>{columns.find((c) => c.key === g.key)?.label ?? g.label}</button>)}
          </Menu>
        )}
        <button className="btn ghost" onClick={() => setRules(true)}><Zap />{t("grid.automations")}</button>
        {canEdit && <button className={`btn ghost ${(cfg.cond_formats ?? []).length ? "on" : ""}`} onClick={() => setCondOpen(true)} title="Formato condicional"><Paintbrush />{t("grid.format")}{(cfg.cond_formats ?? []).length ? ` (${(cfg.cond_formats ?? []).length})` : ""}</button>}
        <span className="right row">
          {toolbar}
          {canEdit && <><button className="btn ghost" disabled={!undoN || busy} onClick={() => replay("undo")} title={undoN ? `${undoStack.current[undoN - 1]!.label} · ${t("grid.undo")}` : t("grid.undo")} aria-label={t("grid.undo")}><Undo2 /></button><button className="btn ghost" disabled={!redoN || busy} onClick={() => replay("redo")} title={t("grid.redo")} aria-label={t("grid.redo")}><Redo2 /></button></>}
          <button className="btn ghost" onClick={() => setHelp(true)} title={t("grid.shortcuts")} aria-label={t("grid.shortcuts")}><Keyboard /></button>
          <button className="btn ghost" onClick={() => setShowCols(true)} title={t("grid.columns")} aria-label={t("grid.columns")}><Columns3 /></button>
          {narrow && canEdit && <Menu fixed trigger={<button className="btn ghost" title={t("grid.cardFields")} aria-label={t("grid.cardFields")}><Smartphone /></button>}><span className="xs muted" style={{ display: "block", padding: "4px 10px", maxWidth: 220 }}>{t("grid.cardFieldsHelp")}</span>{cols.filter((c) => typeOf(c) !== "name").map((c) => { const on = mobileKeys.includes(c.key); return <button key={c.key} role="menuitemcheckbox" aria-checked={on} onClick={() => board.update((b) => ({ ...b, mobile_fields: on ? mobileKeys.filter((k) => k !== c.key) : [...mobileKeys, c.key].slice(-3) }))}>{on ? "☑" : "☐"} {c.label}</button>; })}</Menu>}
          {filters.conditions.length > 0 && <button className="btn ghost" onClick={() => setSaveView(true)} title={t("grid.saveView")} aria-label={t("grid.saveView")}><Save /></button>}
          {exportUrl && <button className="btn ghost" onClick={exportCsv} title={t("grid.export")} aria-label={t("grid.export")}><Download /></button>}
        </span>
      </div>
      {filters.conditions.length > 0 && <div className="small sub mb8">Filtro: {describeFilters(filters)}</div>}

      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && !onCreate && <div className="card"><Empty title={emptyText ?? t("grid.empty")} text={dq || filters.conditions.length ? "Prueba a cambiar la búsqueda o los filtros." : undefined} /></div>}
      <div ref={gridRef} className="grid-focus" tabIndex={0} onKeyDown={onKey} aria-label={t("grid.shortcuts") + ": ?"} aria-activedescendant={active && !narrow ? `cell-${active.r}-${active.c}` : undefined}
        onCopy={(e) => { if (editing || !active || (e.target as HTMLElement).closest("input,textarea")) return; e.preventDefault(); e.clipboardData.setData("text/plain", copyText()); toast(t("grid.copied"), "ok"); }}
        onCut={(e) => { if (editing || !active || (e.target as HTMLElement).closest("input,textarea")) return; e.preventDefault(); e.clipboardData.setData("text/plain", copyText()); clearRange("Cortar"); }}
        onPaste={(e) => { if (editing || !active || (e.target as HTMLElement).closest("input,textarea")) return; if (!canEdit) return; e.preventDefault(); paste(e.clipboardData.getData("text/plain")); }}>
        {data && (data.items.length > 0 || onCreate) && groups.map((g) => (
          <div key={g.key} className={`mgroup ${collapsed[g.key] ? "collapsed" : ""}`} style={{ "--gc": g.color } as React.CSSProperties}>
            {go && (
              <div className="ghead">
                <button className="caret" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))} aria-label={t("grid.collapse")} aria-expanded={!collapsed[g.key]}><Caret size={16} /></button>
                <GroupTitle label={g.label} color={g.color} editable={canEdit && g.key !== "__other"} onRename={(l) => setGroupCfg(g.key, { label: l })} onColor={(c) => setGroupCfg(g.key, { color: c })} />
                <span className="count">{g.rows.length === 1 ? t("grid.item") : t("grid.items", { n: g.rows.length })}</span>
                {canEdit && g.key !== "__other" && (
                  <Menu trigger={<button className="menu-dot show" aria-label={t("grid.groupOptions")}>⋯</button>}>
                    <button onClick={() => moveGroup(g.key, -1)}><ChevronUp />Subir grupo</button>
                    <button onClick={() => moveGroup(g.key, 1)}><ChevronDown />Bajar grupo</button>
                    <button onClick={() => setCollapsed(Object.fromEntries(groups.map((x) => [x.key, true])))}>Plegar todos</button>
                    <button onClick={() => setCollapsed({})}>Desplegar todos</button>
                    <button onClick={() => setGroupCfg(g.key, { hidden: true })}><EyeOff />Ocultar grupo</button>
                  </Menu>
                )}
              </div>
            )}
            {narrow && <div className="mcards" role="list" aria-label={g.label || undefined}>
              {g.rows.map((row) => { const cf = condFor(row); const nameCol = cols.find((c) => typeOf(c) === "name") ?? cols[0]; const fields = mobileKeys.map((k) => cols.find((c) => c.key === k)).filter((c): c is Column<T> => !!c && c !== nameCol);
                return <div key={row.id} role="listitem" className="mcard" style={cf.row}>
                  <button className="mcard-main" onClick={() => onRowClick?.(row)}><b className="ell">{nameCol ? (typeOf(nameCol) === "name" ? String(rawVal(nameCol, row) ?? "") : textOf(nameCol, row)) : row.id}</b>{nameCol?.sub && <span className="xs muted ell">{nameCol.sub(row)}</span>}</button>
                  <dl>{fields.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{typeOf(c) === "status" ? (() => { const o = c.options?.[String(rawVal(c, row) ?? "")]; return o ? <span className="pill-mini" style={pillStyle(o.color)}>{o.label}</span> : <span className="muted">—</span>; })() : (["money", "number"].includes(typeOf(c)) && rawVal(c, row) != null ? showNum(c, Number(rawVal(c, row))) : textOf(c, row) || <span className="muted">—</span>)}</dd></div>)}</dl>
                </div>; })}
            </div>}
            {narrow && onCreate && canEdit && <div className="mcard add"><AddRowInput onCreate={(name) => create(name, g.key)} /></div>}
            {narrow ? null :
            <div className="mwrap">
              <table className="mtbl xg" role="grid" aria-label={g.label || undefined} aria-rowcount={g.rows.length + 1} aria-colcount={cols.length} style={{ width: tableW, tableLayout: "fixed" }}>
                <colgroup><col style={{ width: 6 }} />{bulkActions && <col style={{ width: 36 }} />}{cols.map((c) => <col key={c.key} style={{ width: widthOf(c) }} />)}<col style={{ width: 44 }} /></colgroup>
                <thead><tr role="row" aria-rowindex={1}>
                  <th className="gbar" role="presentation" style={{ position: "sticky", left: 0, zIndex: 3 }} />
                  {bulkActions && <th className="check" style={{ position: "sticky", left: 6, zIndex: 3 }}><input type="checkbox" aria-label={`${t("grid.selectAll")}${g.label ? ` · ${g.label}` : ""}`} checked={g.rows.length > 0 && g.rows.every((r) => sel.includes(r.id))} onChange={(e) => setSel((s) => (e.target.checked ? Array.from(new Set([...s, ...g.rows.map((r) => r.id)])) : s.filter((id) => !g.rows.some((r) => r.id === id))))} /></th>}
                  {cols.map((c, i) => (
                    <th key={c.key} role="columnheader" aria-colindex={i + 1} aria-sort={sort.field === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : c.sortable ? "none" : undefined} className={`${i === 0 || typeOf(c) === "name" ? "l" : ""} ${c.className ?? ""} ${i === freeze - 1 ? "frz-last" : ""} ${dragCol === c.key ? "dragging" : ""}`} style={frz(i)}
                      draggable={canEdit && !resize} onDragStart={(e) => { setDragCol(c.key); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-col", c.key); }} onDragEnd={() => setDragCol(null)}
                      onDragOver={(e) => { if (dragCol && dragCol !== c.key) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (dragCol && dragCol !== c.key) moveColTo(dragCol, c.key); setDragCol(null); }}>
                      <span className="th-in"><span className="th-label" title={c.readOnlyReason ?? (!isEditable(c) && canEdit ? "Solo lectura" : undefined)} onClick={() => c.sortable && setSort((s) => ({ field: c.key, dir: s.field === c.key && s.dir === "desc" ? "asc" : "desc" }))}>{!isEditable(c) && canEdit && <Lock size={10} className="muted" />}{c.label}{sort.field === c.key && (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</span>{headerMenu(c, i)}</span>
                      {canEdit && <span className="th-resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} title="Arrastra para cambiar el ancho" />}
                    </th>
                  ))}
                  <th className="menu addcol">{canEdit && <button className="menu-dot show" title={t("grid.addColumn")} aria-label={t("grid.addColumn")} onClick={() => setAddCol(true)}><Plus size={15} /></button>}</th>
                </tr></thead>
                <tbody>
                  {g.rows.map((row) => {
                    const cf = condFor(row); const ri = rowIdx.get(row.id) ?? -1;
                    return (
                      <tr key={row.id} role="row" aria-rowindex={g.rows.indexOf(row) + 2} aria-selected={sel.includes(row.id) || undefined} className={sel.includes(row.id) ? "sel" : ""}>
                        <td className="gbar" role="presentation" style={{ position: "sticky", left: 0, zIndex: 1 }} />
                        {bulkActions && <td className="check" style={{ position: "sticky", left: 6, zIndex: 1, ...(cf.row ?? {}) }}><input type="checkbox" aria-label={t("grid.selectRow")} checked={sel.includes(row.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, row.id] : s.filter((x) => x !== row.id)))} /></td>}
                        {cols.map((c, i) => {
                          const inR = !!rng && ri >= rng.r0 && ri <= rng.r1 && i >= rng.c0 && i <= rng.c1;
                          const isAct = active?.r === row.id && active.c === c.key;
                          const isEdit = editing?.r === row.id && editing.c === c.key;
                          const handle = !!rng && canEdit && ri === rng.r1 && i === rng.c1 && !editing;
                          const inFill = fillTo !== null && !!rng && i >= rng.c0 && i <= rng.c1 && ((ri > rng.r1 && ri <= fillTo) || (ri < rng.r0 && ri >= fillTo));
                          const nf = fmtFor_(c);
                          const style: React.CSSProperties = { ...(cf.row ?? {}), ...(cf.cells[c.key] ?? {}), ...(frz(i) ?? {}), ...(nf?.align ? { textAlign: nf.align } : {}), ...(nf?.wrap ? { whiteSpace: "normal", lineHeight: 1.3, height: "auto", paddingTop: 6, paddingBottom: 6 } : {}) };
                          return <GridCell key={c.key} ci={i + 1} col={c} type={typeOf(c)} row={row} raw={rawVal(c, row)} edVal={editorVal(c, row)} editable={isEditable(c)} active={isAct} inRange={inR && !isAct} inFill={inFill} editing={isEdit} seed={isEdit ? editing?.seed : undefined} handle={handle} style={style} frozenLast={i === freeze - 1} numFmt={nf} showNum={showNum}
                            onOpen={onRowClick} onClickCell={(e) => cellClick(e, row, c)} onMouseDown={(e) => cellDown(e, row, c)} onMouseEnter={() => cellEnter(row, c)} onDouble={() => startEdit({ r: row.id, c: c.key })} onStartEdit={() => { setAnchor(null); setActive({ r: row.id, c: c.key }); startEdit({ r: row.id, c: c.key }); }}
                            onCommit={(v, mv) => editCommit(row, c, v, mv)} onCancel={() => afterEdit(null)} onFillStart={(e) => { e.preventDefault(); e.stopPropagation(); filling.current = true; setFillTo(rng?.r1 ?? null); }}
                            labelModel={() => labelModel(c)} onSaveLabels={(items, removed) => saveLabels(c, items, removed)} canEditLabels={canEdit && !!labelModel(c)} suggestions={typeOf(c) === "tags" ? Array.from(new Set((data?.items ?? []).flatMap((r) => (Array.isArray(rawVal(c, r)) ? (rawVal(c, r) as string[]) : [])))).concat(c.custom?.options ?? []) : []} />;
                        })}
                        <td className="menu">
                          <Menu fixed trigger={<button className="menu-dot" aria-label={t("grid.rowActions")}>⋯</button>}>
                            {onRowClick && <button onClick={() => onRowClick(row)}>{t("grid.open")}</button>}
                            {onDuplicate && <button onClick={() => duplicate(row)}><Copy />Duplicar</button>}
                            {go?.setValue && groups.filter((x) => x.key !== g.key && x.key !== "__other").map((x) => <button key={x.key} onClick={() => moveRow(row, x.key)}><FolderInput />Mover a <span className="gdot" style={{ background: x.color }} />{x.label}</button>)}
                            {onDelete && <button onClick={() => onDelete([row.id])} style={{ color: "var(--risk-ink)" }}><Trash2 />Borrar</button>}
                          </Menu>
                        </td>
                      </tr>
                    );
                  })}
                  {g.rows.length === 0 && !onCreate && <tr><td className="gbar" />{bulkActions && <td />}<td colSpan={cols.length + 1} className="muted" style={{ textAlign: "left" }}>Sin elementos en este grupo</td></tr>}
                  {onCreate && canEdit && <AddRow colSpan={cols.length + 1 + (bulkActions ? 1 : 0)} onCreate={(name) => create(name, g.key)} onPasteMany={async (names) => { for (const n of names) { try { await onCreate(n, go?.createValue?.(g.key) ?? {}); } catch (e) { toast(errorMessage(e), "error"); break; } } await load(true); toast(`${names.length} elementos creados`, "ok"); }} />}
                  {g.rows.length > 0 && <tr className="sum">
                    <td className="gbar" style={{ position: "sticky", left: 0 }} />{bulkActions && <td style={{ position: "sticky", left: 6 }} />}
                    {cols.map((c, i) => (
                      <td key={c.key} className={summaryKind(typeOf(c)) === "number" ? "sum" : ""} style={frz(i)}>
                        {canEdit ? <Menu fixed trigger={<span className="sumcell" title="Cambiar el resumen">{footer(c, g.rows) ?? <span className="muted xs">＋ resumen</span>}</span>}>
                          {SUMMARY_FNS[summaryKind(typeOf(c))]!.map((f) => <button key={f.key} onClick={() => setSummary(c, f.key)} style={{ fontWeight: sumKey(c) === f.key ? 700 : 400 }}>{f.label}</button>)}
                        </Menu> : footer(c, g.rows)}
                      </td>
                    ))}
                    <td />
                  </tr>}
                </tbody>
              </table>
            </div>}
          </div>
        ))}
      </div>
      {go && canEdit && Object.values(cfg.groups?.[go.key] ?? {}).some((x) => x.hidden) && <button className="btn ghost sm" onClick={() => board.update((c) => ({ ...c, groups: { ...(c.groups ?? {}), [go.key]: Object.fromEntries(Object.entries(c.groups?.[go.key] ?? {}).map(([k, v]) => [k, { ...v, hidden: false }])) } }))}>Mostrar grupos ocultos</button>}
      {data && data.total > pageSize && <div className="card tight" style={{ padding: "0 8px" }}><Pager page={page} pageSize={pageSize} total={data.total} onPage={setPage} /></div>}

      {statusBar && <div className="xl-status" role="status" aria-live="polite">{statusBar.cells} celdas · Recuento: <b>{statusBar.filled}</b>{statusBar.s && <> · Suma: <b>{fmtNum(Math.round(statusBar.s.sum * 100) / 100)}</b> · Promedio: <b>{fmtNum(Math.round(statusBar.s.avg * 100) / 100)}</b> · Mín: <b>{fmtNum(statusBar.s.min)}</b> · Máx: <b>{fmtNum(statusBar.s.max)}</b></>}<span className="xs muted" style={{ marginLeft: 10 }}>Ctrl+C copia · Supr vacía · Ctrl+D rellena</span></div>}
      {busy && <div className="xl-busy" role="status">{t("grid.saving")}</div>}
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
      {labelPop && (() => { const m = labelModel(labelPop.col); return m ? <Pop at={labelPop.at} width={340} onClose={() => setLabelPop(null)}><b className="small">Etiquetas de «{labelPop.col.label}»</b><LabelEditor items={m.items} caps={m.caps} onCancel={() => setLabelPop(null)} onSave={async (items, removed) => { if (await saveLabels(labelPop.col, items, removed)) setLabelPop(null); }} /></Pop> : null; })()}
      {renaming && <RenameDialog title="Renombrar columna" value={renaming.label} onClose={() => setRenaming(null)} onSave={(l) => { setColCfg(renaming.key, { label: l }); setRenaming(null); }} />}
      {rules && <BoardRules object={object} columns={columns as Column<unknown>[]} onClose={() => setRules(false)} />}
      {condOpen && <CondFormatDialog columns={columns.map((c, i) => ({ key: c.key, label: c.label, type: types.get(c.key) ?? colType(c, i), options: c.options }))} rules={cfg.cond_formats ?? []} onClose={() => setCondOpen(false)} onSave={(r) => board.update((b) => ({ ...b, cond_formats: r }))} />}
      {fmtFor && <NumFormatDialog label={fmtFor.label} numeric={["money", "number"].includes(typeOf(fmtFor))} value={cfg.num_formats?.[fmtFor.key] ?? {}} onClose={() => setFmtFor(null)} onSave={(f) => board.update((b) => { const nf = { ...(b.num_formats ?? {}) }; if (f) nf[fmtFor.key] = f; else delete nf[fmtFor.key]; return { ...b, num_formats: nf }; })} />}
      {typeFor && <ChangeTypeDialog field={typeFor} onClose={() => setTypeFor(null)} onDone={async () => { await refresh(); reload(); }} />}
      {help && <Modal title="Atajos de teclado" onClose={() => setHelp(false)}><table className="table"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td className="small">{d}</td></tr>)}</tbody></table><p className="xs muted mt8">Haz clic en una celda para empezar. Pega desde Excel o Google Sheets: los números («1.234,56 €»), fechas («31/12/2026»), casillas («sí», «x») y etiquetas se reconocen solos; si una etiqueta no existe en una columna propia, te ofrece crearla.</p></Modal>}
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

/* ------------------------------------------------------------------ celda */
interface CellProps<T> {
  ci: number;
  col: Column<T>; type: ColumnType; row: T; raw: unknown; edVal: unknown; editable: boolean; active: boolean; inRange: boolean; inFill: boolean; editing: boolean; seed?: string; handle: boolean; style: React.CSSProperties; frozenLast: boolean; numFmt?: NumFormat; showNum: (c: Column<T>, n: number) => string;
  onOpen?: (row: T) => void; onMouseDown: (e: React.MouseEvent) => void; onMouseEnter: () => void; onDouble: () => void; onStartEdit: () => void; onCommit: (v: unknown, move: Move) => void; onCancel: () => void; onFillStart: (e: React.MouseEvent) => void; onClickCell: (e: React.MouseEvent) => void;
  labelModel: () => { items: LabelItem[]; caps: LabelCaps } | null; onSaveLabels: (items: LabelItem[], removed: LabelItem[]) => Promise<boolean>; canEditLabels: boolean; suggestions: string[];
}
function GridCell<T extends { id: string }>(p: CellProps<T>) {
  const { col: c, type, row, raw } = p;
  const ref = useRef<HTMLTableCellElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [labelEdit, setLabelEdit] = useState(false);
  const { users } = useApp();
  useLayoutEffect(() => { if (p.editing && ref.current) { const r = ref.current.getBoundingClientRect(); setAt({ x: Math.min(r.left, window.innerWidth - 270), y: r.bottom + 4 }); } else { setAt(null); setLabelEdit(false); } }, [p.editing]);
  useEffect(() => { if (p.active && ref.current) ref.current.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [p.active]);
  const cls = `${p.active ? "act" : ""} ${p.inRange ? "rng" : ""} ${p.inFill ? "fillp" : ""} ${p.editable ? "" : "ro"} ${p.frozenLast ? "frz-last" : ""}`;
  const common = { ref, id: `cell-${row.id}-${c.key}`, role: "gridcell", "aria-colindex": p.ci, "aria-selected": p.active || p.inRange || undefined, "aria-readonly": !p.editable || undefined, style: p.style, onMouseDown: p.onMouseDown, onMouseEnter: p.onMouseEnter, onDoubleClick: (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("a,button,input,.cdd,.cpop")) return; p.onDouble(); } };
  const handle = p.handle ? <span className="fillh" onMouseDown={p.onFillStart} title="Arrastra para rellenar" /> : null;
  const keyDown = (e: React.KeyboardEvent<HTMLInputElement>, commitVal: () => unknown) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); p.onCancel(); }
    if (e.key === "Enter") { e.preventDefault(); p.onCommit(commitVal(), e.shiftKey ? "up" : "down"); }
    if (e.key === "Tab") { e.preventDefault(); p.onCommit(commitVal(), e.shiftKey ? "left" : "right"); }
  };
  const numText = (n: number) => { const s = p.showNum(c, n); return p.numFmt?.neg_red && n < 0 ? <span style={{ color: "var(--risk-ink)" }}>{s}</span> : s; };

  if (type === "name") {
    if (p.editing) { const v0 = p.seed ?? String(raw ?? ""); return <td {...common} className={`name l edit ${cls} ${c.className ?? ""}`}><input className="ce" autoFocus defaultValue={v0} onFocus={(e) => { if (p.seed !== undefined) e.currentTarget.setSelectionRange(v0.length, v0.length); }} onKeyDown={(e) => keyDown(e, () => e.currentTarget.value.trim() || raw)} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== String(raw ?? "")) p.onCommit(v, null); else p.onCancel(); }} /></td>; }
    return <td {...common} className={`name l ${cls} ${c.className ?? ""}`}>{c.render ? c.render(row) : <a href="#" onClick={(e) => { e.preventDefault(); p.onOpen?.(row); }}>{String(raw ?? "")}</a>}{c.sub && <span className="sub ell">{c.sub(row)}</span>}{p.editable && <button className="rename" title="Renombrar (F2)" onClick={(e) => { e.stopPropagation(); p.onStartEdit(); }} aria-label="Renombrar (F2)"><Pencil size={12} /></button>}{handle}</td>;
  }
  if (type === "status") {
    const opt = c.options?.[String(raw ?? "")];
    const model = labelEdit ? p.labelModel() : null;
    return (
      <td {...common} className={`status ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)} style={{ ...p.style, ...(!p.editable ? { cursor: "default" } : {}) }}>
        <div className="pill" style={pillStyle(opt?.color ?? "#c4c4c4")}>{opt?.label ?? (raw ? String(raw) : "—")}</div>
        {handle}
        {p.editing && at && (model ? <div className="cdd ledit-wrap" style={{ left: Math.min(at.x, window.innerWidth - 360), top: Math.min(at.y, window.innerHeight - 380) }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}><LabelEditor items={model.items} caps={model.caps} onCancel={() => setLabelEdit(false)} onSave={async (items, removed) => { if (await p.onSaveLabels(items, removed)) setLabelEdit(false); }} /></div>
          : <Dropdown at={at} onClose={p.onCancel} footer={p.canEditLabels ? <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => setLabelEdit(true)}><Pencil />Editar etiquetas</button> : undefined}>{Object.entries(c.options ?? {}).filter(([k, o]) => !o.hidden || k === String(raw ?? "")).map(([k, o]) => <button key={k} style={pillStyle(o.color)} title={o.base ? `Se comporta como «${c.options?.[o.base]?.label ?? o.base}»` : undefined} onClick={() => p.onCommit(k, null)}>{o.label}</button>)}{!c.fixedOptions && c.custom && <button style={{ background: "var(--panel)", color: "var(--ink2)", border: "1px dashed var(--rule)" }} onClick={() => p.onCommit(null, null)}>— vacío —</button>}</Dropdown>)}
      </td>
    );
  }
  if (type === "person") {
    const name = c.render ? null : (raw as string | null);
    return (
      <td {...common} className={`person ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)} style={{ ...p.style, ...(!p.editable ? { cursor: "default" } : {}) }} title={name ?? undefined}>
        {c.render ? c.render(row) : name ? <Avatar name={name} /> : <span className="none"><Plus size={12} /></span>}
        {handle}
        {p.editing && at && <Dropdown at={at} list onClose={p.onCancel}><button onClick={() => p.onCommit(null, null)}><span className="none" style={{ width: 24, height: 24, display: "inline-grid", placeItems: "center", border: "1px dashed var(--rule)", borderRadius: "50%" }}>–</span>Sin asignar</button>{users.filter((u) => u.active).map((u) => <button key={u.id} onClick={() => p.onCommit(u.id, null)} style={{ fontWeight: u.id === p.edVal ? 700 : 400 }}><Avatar name={u.name} size="sm" />{u.name}</button>)}</Dropdown>}
      </td>
    );
  }
  if (type === "check") {
    const on = raw === true || raw === 1 || raw === "true";
    return <td {...common} className={`c ${cls} ${c.className ?? ""}`} onClick={() => p.editable && p.onCommit(!on, null)} style={{ ...p.style, cursor: p.editable ? "pointer" : "default" }}><input type="checkbox" readOnly checked={on} style={{ accentColor: "var(--c-green)", width: 16, height: 16, pointerEvents: "none" }} />{handle}</td>;
  }
  if (type === "date" || type === "datetime") {
    const d = raw ? new Date(String(raw)) : null;
    const late = d && d.getTime() < Date.now();
    const soon = d && !late && d.getTime() - Date.now() < 3 * 86400000;
    const iso = d && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
    return (
      <td {...common} className={`date edit ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)}>
        {p.editing ? (p.seed !== undefined
          ? <input aria-label="dd/mm/aaaa" className="ce" autoFocus defaultValue={p.seed} placeholder="dd/mm/aaaa" onKeyDown={(e) => keyDown(e, () => parseDate(e.currentTarget.value) ?? raw)} onBlur={(e) => { const v = parseDate(e.target.value); if (v) p.onCommit(v, null); else p.onCancel(); }} />
          : <input className="ce" type={type === "datetime" ? "datetime-local" : "date"} autoFocus defaultValue={type === "datetime" ? iso.slice(0, 16) : iso.slice(0, 10)} onKeyDown={(e) => keyDown(e, () => e.currentTarget.value ? (type === "datetime" ? new Date(e.currentTarget.value).toISOString() : e.currentTarget.value) : null)} onBlur={(e) => { const v = e.target.value ? (type === "datetime" ? new Date(e.target.value).toISOString() : e.target.value) : null; if ((v ?? "") !== (type === "datetime" ? iso : iso.slice(0, 10))) p.onCommit(v, null); else p.onCancel(); }} />)
          : c.render ? c.render(row) : d && !Number.isNaN(d.getTime()) ? <><i className={`ddot ${late ? "late" : soon ? "soon" : ""}`} />{fmtDate(String(raw), type === "datetime" ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" })}</> : <span className="muted">—</span>}
        {handle}
      </td>
    );
  }
  if (type === "money" || type === "number") {
    const n = raw == null || raw === "" ? null : Number(raw);
    return (
      <td {...common} className={`r num edit ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)}>
        {p.editing ? <input className="ce" autoFocus defaultValue={p.seed ?? (n == null ? "" : String(n).replace(".", ","))} style={{ textAlign: "right" }} onKeyDown={(e) => keyDown(e, () => parseNumber(e.currentTarget.value))} onBlur={(e) => { const v = parseNumber(e.target.value); if (e.target.value.trim() && v === null) { p.onCancel(); return; } if (v !== n) p.onCommit(v, null); else p.onCancel(); }} />
          : p.numFmt && n !== null && !Number.isNaN(n) ? numText(n) : c.render ? c.render(row) : n === null ? <span className="muted">—</span> : type === "money" ? fmtMoney(n) : fmtNum(n)}
        {handle}
      </td>
    );
  }
  if (type === "tags" || type === "longtext" || type === "timeline" || type === "relation") {
    const tags = Array.isArray(raw) ? (raw as string[]) : [];
    const view = c.render ? c.render(row) : type === "tags" ? tags.map((t) => <span key={t} className="tag">{t}</span>) : type === "timeline" ? (raw ? `${fmtIsoDate((raw as { from?: string }).from)} – ${fmtIsoDate((raw as { to?: string }).to)}` : <span className="muted">—</span>) : raw ? <span className="ell" style={{ display: "block" }}>{String(raw)}</span> : <span className="muted">—</span>;
    return (
      <td {...common} className={`${type === "tags" ? "tags" : "l"} ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)}>
        {view}{handle}
        {p.editing && at && <Pop at={at} onClose={p.onCancel} width={type === "longtext" ? 360 : 300}>
          {type === "tags" && <TagsEditor value={tags} suggestions={p.suggestions} onCommit={(v) => p.onCommit(v, null)} onCancel={p.onCancel} />}
          {type === "longtext" && <LongTextEditor value={String(raw ?? "")} onCommit={(v) => p.onCommit(v || null, null)} onCancel={p.onCancel} />}
          {type === "timeline" && <RangeEditor value={raw as { from?: string; to?: string } | null} onCommit={(v) => p.onCommit(v, null)} onCancel={p.onCancel} />}
          {type === "relation" && c.relation && <RelationPicker endpoint={c.relation.endpoint} labelOf={c.relation.labelOf} onPick={(r) => p.onCommit(r ? r.id : null, null)} onCancel={p.onCancel} />}
        </Pop>}
      </td>
    );
  }
  return (
    <td {...common} className={`${p.editable ? "edit" : ""} ${cls} ${c.className ?? ""}`} onClick={(e) => p.editable && !p.editing && p.onClickCell(e)}>
      {p.editing ? <input className="ce" autoFocus defaultValue={p.seed ?? String(raw ?? "")} onKeyDown={(e) => keyDown(e, () => e.currentTarget.value || null)} onBlur={(e) => { if (e.target.value !== String(raw ?? "")) p.onCommit(e.target.value || null, null); else p.onCancel(); }} />
        : c.render ? c.render(row) : (raw === null || raw === undefined || raw === "" ? <span className="muted">—</span> : String(raw))}
      {handle}
    </td>
  );
}

function GroupTitle({ label, color, editable, onRename, onColor }: { label: string; color: string; editable: boolean; onRename: (l: string) => void; onColor: (c: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(false);
  if (editing) return <input className="input sm" autoFocus defaultValue={label} style={{ width: 220, color }} onBlur={(e) => { setEditing(false); if (e.target.value.trim() && e.target.value.trim() !== label) onRename(e.target.value.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }} />;
  return (
    <span className="row" style={{ gap: 6, position: "relative" }}>
      <h2 onClick={() => editable && setEditing(true)} style={{ color: readable(color), ...(editable ? { cursor: "text" } : {}) }} title={editable ? "Clic para renombrar" : undefined}>{label}</h2>
      {editable && <button className="iconbtn" style={{ width: 22, height: 22 }} title="Color del grupo" onClick={() => setPick((x) => !x)} aria-label="Color del grupo"><Palette size={13} /></button>}
      {pick && <ColorPicker value={color} onPick={(c) => { onColor(c); setPick(false); }} onClose={() => setPick(false)} />}
    </span>
  );
}

function AddRow({ colSpan, onCreate, onPasteMany }: { colSpan: number; onCreate: (name: string) => Promise<void> | void; onPasteMany: (names: string[]) => Promise<void> }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => { if (!v.trim() || busy) return; setBusy(true); try { await onCreate(v); setV(""); } finally { setBusy(false); } };
  return <tr className="addrow"><td className="gbar" /><td colSpan={colSpan} className="l"><span className="row"><Plus size={14} className="muted" /><input className="addrow-in" placeholder={t("grid.addItem")} aria-label={t("grid.addItem")} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") submit(); if (e.key === "Escape") setV(""); }} onPaste={(e) => { const lines = parseTSV(e.clipboardData.getData("text/plain")).map((l) => (l[0] ?? "").trim()).filter(Boolean); if (lines.length > 1) { e.preventDefault(); e.stopPropagation(); setBusy(true); onPasteMany(lines).finally(() => setBusy(false)); } }} onBlur={() => v.trim() && submit()} disabled={busy} /></span></td></tr>;
}

function AddRowInput({ onCreate }: { onCreate: (name: string) => Promise<void> | void }) {
  const [v, setV] = useState("");
  return <input className="input" placeholder={t("grid.addItem")} aria-label={t("grid.addItem")} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={async (e) => { if (e.key === "Enter" && v.trim()) { await onCreate(v.trim()); setV(""); } }} />;
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
  return <div ref={ref} className={`cdd ${list ? "list" : ""}`} style={{ left: at.x, top: y }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{children}{footer && <div className="cdd-foot">{footer}</div>}</div>;
}

const COL_TYPES: { key: CustomField["type"]; label: string; help: string }[] = [
  { key: "status", label: "Estado", help: "Etiquetas de color" }, { key: "text", label: "Texto", help: "Una línea" }, { key: "textarea", label: "Texto largo", help: "Varias líneas" },
  { key: "number", label: "Número", help: "" }, { key: "currency", label: "Importe", help: "Moneda" }, { key: "percent", label: "Porcentaje", help: "" }, { key: "date", label: "Fecha", help: "" }, { key: "datetime", label: "Fecha y hora", help: "" }, { key: "timeline", label: "Línea temporal", help: "Inicio–fin" },
  { key: "user", label: "Persona", help: "Usuario del equipo" }, { key: "boolean", label: "Casilla", help: "Sí / no" }, { key: "select", label: "Desplegable", help: "Una opción" }, { key: "multiselect", label: "Etiquetas múltiples", help: "" }, { key: "rating", label: "Valoración", help: "Estrellas" },
  { key: "url", label: "Enlace", help: "" }, { key: "email", label: "Email", help: "" }, { key: "phone", label: "Teléfono", help: "" },
  { key: "formula", label: "Fórmula", help: "Cálculo por fila" }, { key: "mirror", label: "Reflejo", help: "De registros conectados" }, { key: "button", label: "Botón", help: "Dispara automatizaciones" }, { key: "autonumber", label: "Autonumeración", help: "" }, { key: "creation_log", label: "Registro de creación", help: "" }, { key: "last_updated", label: "Última actualización", help: "" },
];
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]/, "c$&") || "campo";

function AddColumnDialog({ object, onClose, onCreated }: { object: string; onClose: () => void; onCreated: (f: CustomField) => Promise<void> }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomField["type"]>("status");
  const [options, setOptions] = useState<string[]>(["Pendiente", "En curso", "Hecho"]);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const save = async () => {
    if (!label.trim()) return; setBusy(true);
    try { const f = await api.post<CustomField>("admin/custom-fields", { object, key: slug(label), label: label.trim(), type, options: type === "select" || type === "multiselect" ? options.filter(Boolean) : undefined, settings }); toast("Columna añadida", "ok"); await onCreated(f); onClose(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nueva columna" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !label.trim()} onClick={save}>Crear columna</button></>}>
      <div className="col" style={{ gap: 14 }}>
        <Field label="Nombre de la columna"><input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Prioridad interna" onKeyDown={(e) => e.key === "Enter" && save()} /></Field>
        <Field label="Tipo"><div className="type-grid">{COL_TYPES.map((t) => <button key={t.key} className={`type-btn ${type === t.key ? "active" : ""}`} onClick={() => { setType(t.key); setSettings({}); }}><b>{t.label}</b>{t.help && <span>{t.help}</span>}</button>)}</div></Field>
        <div className="form-grid" style={{ padding: 0 }}><ColumnSettings object={object} type={type} settings={settings} onChange={setSettings} /></div>
        {(type === "select" || type === "multiselect") && <Field label="Opciones"><div className="col" style={{ gap: 6 }}>{options.map((o, i) => <div key={i} className="row"><span className="gdot" style={{ background: PALETTE[(i * 3) % PALETTE.length] }} /><input className="input sm" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} /><button className="iconbtn" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Cerrar"><X size={14} /></button></div>)}<button className="btn ghost sm" onClick={() => setOptions([...options, ""])}><Plus />Añadir opción</button></div></Field>}
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
