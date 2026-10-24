import type { Request } from "express";
import type { Db, Row } from "./db.js";

export type Permissions = { [object: string]: string[] | boolean | undefined; admin?: boolean };
export type Visibility = "own" | "team" | "all";

export interface User extends Row {
  id: string;
  workspace_id: string;
  name: string;
  email: string;
  role_id: string;
  team_id: string | null;
  active: number;
  totp_enabled: number;
  notification_prefs: Record<string, unknown>;
}
export interface Role extends Row {
  id: string;
  key: string;
  name: string;
  permissions: Permissions;
  visibility: Visibility;
}

export interface Ctx {
  db: Db;
  ws: string;
  user: User;
  role: Role;
  ip: string;
  via: "session" | "apikey";
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  company_name: string;
  currency: string;
  timezone: string;
  date_format: string;
  default_country_code: string;
  internal_domains: string[];
  fiscal_year_start: number;
  stale_deal_days: number;
  inactive_deal_days: number;
  lead_sla_hours: number;
  mql_threshold: number;
  sql_threshold: number;
  retention_months: number;
  retention_enabled: boolean;
  quote_prefix: string;
  quote_accept_stage_id: string | null;
  ticket_sla_hours: Record<string, number>;
  logo_url: string;
  brand_color: string;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  company_name: "Mi empresa",
  currency: "EUR",
  timezone: "Europe/Madrid",
  date_format: "dd/MM/yyyy",
  default_country_code: "+34",
  internal_domains: [],
  fiscal_year_start: 1,
  stale_deal_days: 14,
  inactive_deal_days: 7,
  lead_sla_hours: 24,
  mql_threshold: 50,
  sql_threshold: 80,
  retention_months: 36,
  retention_enabled: false,
  quote_prefix: "P",
  quote_accept_stage_id: null,
  ticket_sla_hours: { low: 72, normal: 24, high: 8, urgent: 2 },
  logo_url: "",
  brand_color: "#0E6B74",
};

export type AuthedRequest = Request & { ctx: Ctx };
