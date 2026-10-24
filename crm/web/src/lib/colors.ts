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
export const statusClass = (opts: Record<string, StatusOption>, k: string | null | undefined) => opts[k ?? ""] ?? { label: k ?? "—", color: C.grey };
