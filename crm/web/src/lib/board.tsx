import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useApp, type CustomField, type StatusLabel } from "./app";
import type { Column, StatusOption } from "../components/DataTable";
import { fmtDate } from "./format";

/** monday-like colour palette for labels, groups and stages */
export const PALETTE = ["#0073ea", "#579bfc", "#66ccff", "#a25ddc", "#784bd1", "#5559df", "#00c875", "#9cd326", "#cab641", "#fdab3d", "#ff642e", "#e2445c", "#ff158a", "#bb3354", "#7f5347", "#c4c4c4", "#808080", "#323338", "#175a63", "#037f4c"];

export interface BoardColumnCfg { key: string; label?: string; width?: number; hidden?: boolean }
export interface BoardConfig {
  columns?: BoardColumnCfg[];
  order?: string[];
  labels?: Record<string, Record<string, { label?: string; color?: string }>>;
  group_by?: string | null;
  groups?: Record<string, Record<string, { label?: string; color?: string; hidden?: boolean }>>;
  group_order?: Record<string, string[]>;
}
export interface Board { object: string; config: BoardConfig; loaded: boolean; update: (patch: Partial<BoardConfig> | ((c: BoardConfig) => BoardConfig)) => void }

/** Loads and persists the shared board configuration for an object (columns, labels, groups). */
export function useBoard(object: "contact" | "company" | "deal" | "ticket" | "contract"): Board {
  const [config, setConfig] = useState<BoardConfig>({});
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(config);
  const timer = useRef<number | null>(null);
  useEffect(() => { api.get<{ config: BoardConfig }>(`boards/${object}`).then((r) => { setConfig(r.config ?? {}); latest.current = r.config ?? {}; }).catch(() => undefined).finally(() => setLoaded(true)); }, [object]);
  const update = useCallback((patch: Partial<BoardConfig> | ((c: BoardConfig) => BoardConfig)) => {
    const next = typeof patch === "function" ? patch(latest.current) : { ...latest.current, ...patch };
    latest.current = next; setConfig(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { api.put(`boards/${object}`, next).catch(() => undefined); }, 300);
  }, [object]);
  return { object, config, loaded, update };
}

/** Builds typed, editable columns for the object's custom fields. */
export function customColumns<T extends { id: string; custom?: Record<string, unknown> }>(defs: CustomField[], object: string, board: Board, patch?: (row: T, key: string, value: unknown) => Promise<void> | void, userName?: (id: string) => string): Column<T>[] {
  return defs.filter((f) => f.object === object).map<Column<T>>((f) => {
    const key = `custom.${f.key}`;
    const value = (r: T) => r.custom?.[f.key];
    const onEdit = patch ? (r: T, v: unknown) => patch(r, f.key, v) : undefined;
    const base: Column<T> = { key, label: f.label, sortable: true, default: true, value, onEdit, custom: f };
    const st = (f.settings ?? {}) as Record<string, unknown>;
    const err = (r: T) => ((r as unknown as { _computed_errors?: Record<string, string> })._computed_errors ?? {})[f.key];
    const ro = (fmt: (v: unknown) => ReactNode, extra: Partial<Column<T>> = {}): Column<T> => ({ ...base, onEdit: undefined, className: "l", render: (r) => { const e = err(r); if (e) return <span className="risk small" title={e}>#ERROR</span>; const v = value(r); return v === null || v === undefined || v === "" ? <span className="muted">—</span> : fmt(v); }, ...extra });
    switch (f.type) {
      case "status": {
        const labels = (st.labels as StatusLabel[] | undefined) ?? [];
        const options: Record<string, StatusOption> = Object.fromEntries(labels.map((l) => [String(l.id), { label: l.label, color: l.color }]));
        return { ...base, type: "status", options, value: (r) => (value(r) == null ? null : String(value(r))), onEdit: patch ? (r, v) => patch(r, f.key, v == null || v === "" ? null : Number(v)) : undefined };
      }
      case "rating": {
        const max = Number(st.max ?? 5);
        return { ...base, onEdit: undefined, render: (r) => <span className="rating" onClick={(e) => e.stopPropagation()}>{Array.from({ length: max }, (_, i) => <button key={i} className={i < Number(value(r) ?? 0) ? "on" : ""} title={`${i + 1}`} onClick={() => patch?.(r, f.key, Number(value(r) ?? 0) === i + 1 ? 0 : i + 1)}>★</button>)}</span> };
      }
      case "timeline": return { ...base, sortable: false, onEdit: undefined, render: (r) => { const v = value(r) as { from?: string; to?: string } | null; if (!v?.from) return <span className="muted">—</span>; const a = new Date(v.from).getTime(), b = new Date(v.to ?? v.from).getTime(), now = Date.now(); const p = b > a ? Math.max(0, Math.min(100, ((now - a) / (b - a)) * 100)) : now >= b ? 100 : 0; return <span className="tlbar" title={`${v.from} – ${v.to}`}><i style={{ width: `${p}%` }} /><span>{fmtDate(v.from, { day: "2-digit", month: "short" })} – {fmtDate(v.to, { day: "2-digit", month: "short" })}</span></span>; } };
      case "button": return { ...base, sortable: false, onEdit: undefined, render: (r) => <button className="cellbtn" style={{ background: String(st.color ?? "#0073ea") }} onClick={async (e) => { e.stopPropagation(); const b = e.currentTarget; const t = b.textContent; b.disabled = true; try { await api.post(`cells/${object}/${r.id}/button/${f.key}`, {}); b.textContent = "✓ Hecho"; } catch { b.textContent = "Error"; } setTimeout(() => { b.textContent = t; b.disabled = false; }, 1600); }}>{String(st.label ?? f.label)}</button> };
      case "formula": {
        const isNum = st.result === "number";
        if (isNum) return { ...base, type: "number", onEdit: undefined, render: (r) => { const e = err(r); return e ? <span className="risk small" title={e}>#ERROR</span> : value(r) == null || value(r) === "" ? <span className="muted">—</span> : <span className="num">{new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(Number(value(r)))}</span>; } };
        return ro((v) => (typeof v === "boolean" ? (v ? "Sí" : "No") : String(v)), { custom: f });
      }
      case "mirror": {
        const numeric = ["sum", "avg", "median", "min", "max", "count", "count_not_empty", "pct_eq"].includes(String(st.agg));
        if (numeric) return { ...base, type: "number", agg: ["avg", "median", "pct_eq", "min", "max"].includes(String(st.agg)) ? "avg" : "sum", onEdit: undefined, render: (r) => (value(r) == null ? <span className="muted">—</span> : <span className="num" title="Reflejo">{new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(Number(value(r)))}{st.agg === "pct_eq" ? " %" : ""}</span>) };
        return ro((v) => (typeof v === "boolean" ? <span className={`badge ${v ? "ok" : ""}`}>{v ? "Sí" : "No"}</span> : Array.isArray(v) ? (v.length ? v.join(", ") : <span className="muted">—</span>) : String(v)));
      }
      case "autonumber": return ro((v) => <code>{String(v)}</code>);
      case "creation_log": case "last_updated": return ro((v) => fmtDate(String(v), { day: "2-digit", month: "short", year: "numeric" }));
      case "select": {
        const overrides = board.config.labels?.[key] ?? {};
        const options: Record<string, StatusOption> = Object.fromEntries(f.options.map((o, i) => [o, { label: overrides[o]?.label ?? o, color: overrides[o]?.color ?? PALETTE[(i * 3) % PALETTE.length]! }]));
        return { ...base, type: "status", options };
      }
      case "multiselect": return { ...base, type: "tags", sortable: false, onEdit: undefined };
      case "number": case "percent": return { ...base, type: "number", render: f.type === "percent" ? (r) => (value(r) == null ? <span className="muted">—</span> : `${value(r)}%`) : undefined };
      case "currency": return { ...base, type: "money" };
      case "date": case "datetime": return { ...base, type: "date", render: f.type === "datetime" ? (r) => (value(r) ? fmtDate(String(value(r)), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : <span className="muted">—</span>) : undefined };
      case "user": return { ...base, type: "person", value: (r) => (value(r) ? (userName?.(String(value(r))) ?? String(value(r))) : null), onEdit };
      case "boolean": return { ...base, type: "check" };
      case "url": return { ...base, className: "l", render: (r) => (value(r) ? <a href={String(value(r))} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(value(r))}</a> : <span className="muted">—</span>) };
      default: return { ...base, className: "l" };
    }
  });
}

/** Applies board overrides (labels, colours, order, widths, visibility) to a page's columns. */
export function applyBoard<T>(columns: Column<T>[], board: Board): Column<T>[] {
  const cfg = board.config;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const ordered: Column<T>[] = [];
  for (const k of cfg.order ?? []) { const c = byKey.get(k); if (c) { ordered.push(c); byKey.delete(k); } }
  const all = [...ordered, ...byKey.values()];
  return all.map((c) => {
    const cc = cfg.columns?.find((x) => x.key === c.key);
    const out: Column<T> = { ...c };
    if (cc?.label) out.label = cc.label;
    if (cc?.width) out.width = cc.width;
    if (cc?.hidden !== undefined) out.default = !cc.hidden;
    if (c.type === "status" && c.options && cfg.labels?.[c.key]) {
      const ov = cfg.labels[c.key]!;
      out.options = Object.fromEntries(Object.entries(c.options).map(([k, o]) => [k, { label: ov[k]?.label ?? o.label, color: ov[k]?.color ?? o.color }]));
    }
    return out;
  });
}

export function useBoardHelpers() {
  const { customFields, refresh, userName } = useApp();
  return { customFields, refresh, userName };
}
