import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp, type CustomField } from "./app";
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
    switch (f.type) {
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
