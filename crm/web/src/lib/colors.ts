import type { StatusOption } from "../components/DataTable";
import { LIFECYCLE, LEAD_STATUS, COMPANY_TYPES, TICKET_STATUS, PRIORITY, DEAL_STATUS, QUOTE_STATUS } from "./format";

export const C = { blue: "#579bfc", purple: "#a25ddc", green: "#00c875", red: "#e2445c", orange: "#fdab3d", dark: "#323338", teal: "#66ccff", grey: "#c4c4c4", indigo: "#5559df", violet: "#784bd1", lime: "#9cd326", pink: "#ff158a", sea: "#0073ea" } as const;

const opts = (labels: Record<string, string>, colors: Record<string, string>): Record<string, StatusOption> => Object.fromEntries(Object.entries(labels).map(([k, label]) => [k, { label, color: colors[k] ?? C.grey }]));

export const LIFECYCLE_OPTS = opts(LIFECYCLE, { subscriber: C.grey, lead: C.blue, mql: C.indigo, sql: C.violet, opportunity: C.purple, customer: C.green, evangelist: C.lime, lost: C.red });
export const LEAD_STATUS_OPTS = opts(LEAD_STATUS, { new: C.blue, contacted: C.orange, qualified: C.green, unqualified: C.red, nurturing: C.purple });
export const COMPANY_TYPE_OPTS = opts(COMPANY_TYPES, { prospect: C.blue, customer: C.green, partner: C.purple, competitor: C.red, supplier: C.orange });
export const TICKET_STATUS_OPTS = opts(TICKET_STATUS, { new: C.blue, open: C.orange, pending: C.purple, resolved: C.green, closed: C.dark });
export const PRIORITY_OPTS = opts(PRIORITY, { low: C.teal, normal: C.blue, high: C.orange, urgent: C.red });
export const DEAL_STATUS_OPTS = opts(DEAL_STATUS, { open: C.blue, won: C.green, lost: C.red });
export const QUOTE_STATUS_OPTS = opts(QUOTE_STATUS, { draft: C.grey, sent: C.blue, viewed: C.purple, accepted: C.green, rejected: C.red, expired: C.orange });
/** Texto legible sobre un color de fondo (WCAG): elige blanco o casi negro según cuál contraste más. */
export function inkOn(bg: string | null | undefined): string {
  const m = String(bg ?? "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return "#fff";
  let h = m[1]!; if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const lin = (i: number) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.0625 ? "#fff" : "#1f1f1f";
}
/** Variante de un color usable como texto sobre el fondo de la página (≥ 4.5:1), oscureciendo o aclarando según el tema. */
export function readable(color: string | null | undefined): string | undefined {
  const m = String(color ?? "").trim().match(/^#?([0-9a-f]{6})$/i); if (!m) return undefined;
  const dark = document.documentElement.getAttribute("data-theme") === "dark" || (document.documentElement.getAttribute("data-theme") !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const bg = dark ? [0x18, 0x1b, 0x34] : [0xf6, 0xf7, 0xfb];
  const lum = (c: number[]) => { const l = c.map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!; };
  let rgb = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
  const lb = lum(bg);
  for (let k = 0; k < 20; k++) { const l = lum(rgb); const cr = (Math.max(l, lb) + 0.05) / (Math.min(l, lb) + 0.05); if (cr >= 4.5) break; rgb = rgb.map((x) => Math.round(dark ? x + (255 - x) * 0.15 : x * 0.85)); }
  return `#${rgb.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
/** Estilo de una etiqueta de color: fondo y texto con contraste. */
export const pillStyle = (bg: string | null | undefined, extra: React.CSSProperties = {}): React.CSSProperties => ({ background: bg ?? C.grey, color: inkOn(bg ?? C.grey), ...extra });
export const statusClass =(opts: Record<string, StatusOption>, k: string | null | undefined) => opts[k ?? ""] ?? { label: k ?? "—", color: C.grey };
