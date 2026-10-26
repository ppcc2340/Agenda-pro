/**
 * Utilidades de la tabla tipo Excel: lectura de lo que se pega (formato español), TSV, formatos de número,
 * formato condicional y funciones de resumen del pie.
 */
import { locale } from "./prefs";
export const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** «1.234,56 €» → 1234.56 · «12 %» → 12 · «-3» → -3. */
export function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  let s = String(v).trim().replace(/[€$£%\s]|uds?\.?|h$/gi, "");
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,(?=\d{3}\b)/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** «31/12/2026», «31-12-26», «2026-12-31» → «2026-12-31». */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) { const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`; }
  return null;
}
export function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  if (["si", "yes", "true", "1", "x", "✓", "verdadero", "hecho", "ok"].includes(s)) return true;
  if (["no", "false", "0", "falso", ""].includes(s)) return false;
  return null;
}
export const fmtIsoDate = (iso: unknown) => { const d = parseDate(iso); if (!d) return ""; const [y, m, dd] = d.split("-"); return `${dd}/${m}/${y}`; };
export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Lee texto tabulado (Excel, Sheets, CSV con tabuladores), respetando comillas con saltos de línea. */
export function parseTSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"' && cur === "") { q = true; continue; }
    if (ch === "\t") { row.push(cur); cur = ""; continue; }
    if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export function toTSV(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\n");
}

export interface NumFormat { decimals?: number; thousands?: boolean; prefix?: string; suffix?: string; neg_red?: boolean; align?: "left" | "center" | "right"; wrap?: boolean }
export function formatNumber(n: number, f: NumFormat): string {
  const d = f.decimals ?? 0;
  const s = new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: f.thousands !== false }).format(n);
  return `${f.prefix ?? ""}${s}${f.suffix ?? ""}`;
}

export interface CondRule { id: string; column: string; op: string; value?: unknown; value2?: unknown; bg?: string; color?: string; bold?: boolean; scope?: "cell" | "row"; enabled?: boolean }
export const COND_OPS: { key: string; label: string; arity: 0 | 1 | 2; types?: string[] }[] = [
  { key: "eq", label: "es igual a", arity: 1 }, { key: "ne", label: "no es igual a", arity: 1 },
  { key: "gt", label: "mayor que", arity: 1, types: ["number", "money", "date"] }, { key: "lt", label: "menor que", arity: 1, types: ["number", "money", "date"] },
  { key: "gte", label: "mayor o igual que", arity: 1, types: ["number", "money", "date"] }, { key: "lte", label: "menor o igual que", arity: 1, types: ["number", "money", "date"] },
  { key: "between", label: "entre", arity: 2, types: ["number", "money", "date"] },
  { key: "contains", label: "contiene", arity: 1, types: ["text", "name", "tags", "longtext"] }, { key: "not_contains", label: "no contiene", arity: 1, types: ["text", "name", "tags", "longtext"] },
  { key: "empty", label: "está vacío", arity: 0 }, { key: "not_empty", label: "no está vacío", arity: 0 },
  { key: "overdue", label: "fecha vencida", arity: 0, types: ["date"] }, { key: "next_days", label: "vence en los próximos N días", arity: 1, types: ["date"] },
  { key: "checked", label: "está marcada", arity: 0, types: ["check"] }, { key: "unchecked", label: "no está marcada", arity: 0, types: ["check"] },
];
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
/** Evalúa una regla sobre el valor de la celda (clave de etiqueta para estados, ISO para fechas). */
export function ruleMatches(rule: CondRule, value: unknown, type: string, text: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const num = (x: unknown) => (type === "date" ? String(parseDate(x) ?? "") : parseNumber(x));
  const cmp = (a: unknown, b: unknown) => { const x = num(a), y = num(b); if (x === null || y === null || x === "" || y === "") return NaN; return x < y ? -1 : x > y ? 1 : 0; };
  switch (rule.op) {
    case "eq": return type === "status" || type === "person" ? String(value ?? "") === String(rule.value ?? "") || norm(text) === norm(rule.value) : ["number", "money", "date"].includes(type) ? cmp(value, rule.value) === 0 : norm(text) === norm(rule.value);
    case "ne": return !ruleMatches({ ...rule, op: "eq" }, value, type, text);
    case "gt": return cmp(value, rule.value) > 0;
    case "lt": return cmp(value, rule.value) < 0;
    case "gte": return cmp(value, rule.value) >= 0;
    case "lte": return cmp(value, rule.value) <= 0;
    case "between": return cmp(value, rule.value) >= 0 && cmp(value, rule.value2) <= 0;
    case "contains": return norm(text).includes(norm(rule.value));
    case "not_contains": return !norm(text).includes(norm(rule.value));
    case "empty": return isEmpty(value);
    case "not_empty": return !isEmpty(value);
    case "overdue": { const d = parseDate(value); return !!d && d < today; }
    case "next_days": { const d = parseDate(value); if (!d) return false; const days = (Date.parse(d) - Date.parse(today)) / 864e5; return days >= 0 && days <= Number(rule.value ?? 7); }
    case "checked": return value === true || value === 1 || value === "true";
    case "unchecked": return !(value === true || value === 1 || value === "true");
    default: return false;
  }
}

/** Funciones del pie por tipo de columna. */
export const SUMMARY_FNS: Record<string, { key: string; label: string }[]> = {
  number: [{ key: "sum", label: "Suma" }, { key: "avg", label: "Media" }, { key: "median", label: "Mediana" }, { key: "min", label: "Mínimo" }, { key: "max", label: "Máximo" }, { key: "count", label: "Recuento" }, { key: "empty", label: "Vacíos" }, { key: "filled", label: "% lleno" }, { key: "none", label: "Ninguno" }],
  status: [{ key: "dist", label: "Distribución" }, { key: "counts", label: "Recuento por etiqueta" }, { key: "filled", label: "% lleno" }, { key: "none", label: "Ninguno" }],
  check: [{ key: "checked", label: "Marcadas (n/total)" }, { key: "pct", label: "% marcadas" }, { key: "none", label: "Ninguno" }],
  date: [{ key: "earliest", label: "Más temprana" }, { key: "latest", label: "Más tardía" }, { key: "range", label: "Rango" }, { key: "count", label: "Recuento" }, { key: "empty", label: "Vacíos" }, { key: "none", label: "Ninguno" }],
  other: [{ key: "count", label: "Recuento" }, { key: "unique", label: "Valores únicos" }, { key: "empty", label: "Vacíos" }, { key: "filled", label: "% lleno" }, { key: "none", label: "Ninguno" }],
};
export const summaryKind = (type: string) => (type === "money" || type === "number" ? "number" : type === "status" ? "status" : type === "check" ? "check" : type === "date" ? "date" : "other");
export function numericStats(values: unknown[]) {
  const nums = values.map((v) => parseNumber(v)).filter((n): n is number => n !== null);
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : 0;
  return { n: nums.length, sum, avg: nums.length ? sum / nums.length : 0, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, median };
}
/** Continúa una serie al rellenar: números con paso constante, fechas (+1 día o el paso detectado) o repetición. */
export function fillSeries(seed: unknown[], count: number, type: string): unknown[] {
  const out: unknown[] = [];
  if ((type === "number" || type === "money") && seed.length >= 2 && seed.every((v) => parseNumber(v) !== null)) {
    const nums = seed.map((v) => parseNumber(v)!); const step = nums[nums.length - 1]! - nums[nums.length - 2]!;
    for (let i = 1; i <= count; i++) out.push(Math.round((nums[nums.length - 1]! + step * i) * 1e6) / 1e6);
    return out;
  }
  if (type === "date" && seed.length && seed.every((v) => parseDate(v))) {
    const ds = seed.map((v) => parseDate(v)!); const step = ds.length >= 2 ? Math.round((Date.parse(ds[ds.length - 1]!) - Date.parse(ds[ds.length - 2]!)) / 864e5) : 1;
    for (let i = 1; i <= count; i++) out.push(addDays(ds[ds.length - 1]!, step * i));
    return out;
  }
  for (let i = 0; i < count; i++) out.push(seed[i % Math.max(1, seed.length)]);
  return out;
}
