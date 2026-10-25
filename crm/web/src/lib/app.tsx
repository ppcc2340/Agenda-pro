/** Global app data: current user, settings, users, pipelines, custom fields. */
import { createContext, useContext, useEffect, useState, type ReactNode, useCallback } from "react";
import { api } from "../api";

export interface Me { id: string; name: string; email: string; role_id: string; role: { key: string; name: string; visibility: string; permissions: Record<string, string[] | boolean | undefined> }; team: { id: string; name: string } | null; totp_enabled: boolean; email_signature: string | null; notification_prefs: Record<string, unknown>; quota: number | null }
export interface Settings { company_name: string; currency: string; timezone: string; default_country_code: string; internal_domains: string[]; stale_deal_days: number; inactive_deal_days: number; lead_sla_hours: number; mql_threshold: number; sql_threshold: number; retention_months: number; retention_enabled: boolean; quote_prefix: string; quote_accept_stage_id: string | null; ticket_sla_hours: Record<string, number>; logo_url: string; brand_color: string; date_format: string; fiscal_year_start: number }
export interface UserLite { id: string; name: string; email: string; active: boolean; team_id: string | null; role: { key: string; name: string } | null }
export interface Stage { id: string; pipeline_id: string; name: string; position: number; probability: number; color: string; expected_days: number; required_fields: string[]; kind: "open" | "won" | "lost" }
export interface Pipeline { id: string; name: string; is_default: number; position: number; stages: Stage[] }
export interface CustomField { id: string; object: string; key: string; label: string; type: string; options: string[]; required: number; default_value: string | null; position: number; section: string | null; show_if: { field: string; value: string } | null; settings?: Record<string, unknown> }
export interface StatusLabel { id: number; label: string; color: string; done?: boolean }
export interface LabelSet { id: string; name: string; labels: StatusLabel[]; used_by?: number }

interface AppData { me: Me; settings: Settings; users: UserLite[]; pipelines: Pipeline[]; customFields: CustomField[]; labelSets: LabelSet[]; teams: { id: string; name: string; manager_id: string | null }[]; refresh: () => Promise<void>; can: (object: string, action: string) => boolean; isAdmin: boolean; userName: (id: string | null | undefined) => string }
const Ctx = createContext<AppData | null>(null);
export const useApp = () => { const v = useContext(Ctx); if (!v) throw new Error("AppProvider missing"); return v; };

export function AppProvider({ me, settings, onLogout, children }: { me: Me; settings: Settings; onLogout: () => void; children: ReactNode }) {
  const [users, setUsers] = useState<UserLite[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [teams, setTeams] = useState<AppData["teams"]>([]);
  const [labelSets, setLabelSets] = useState<LabelSet[]>([]);
  const [st, setSt] = useState(settings);
  const refresh = useCallback(async () => {
    const [u, p, c, t, s, ls] = await Promise.all([
      api.get<{ items: UserLite[] }>("admin/users"), api.get<{ items: Pipeline[] }>("pipelines"), api.get<{ items: CustomField[] }>("admin/custom-fields"), api.get<{ items: AppData["teams"] }>("admin/teams"), api.get<{ settings: Settings }>("admin/settings"), api.get<{ items: LabelSet[] }>("columns/label-sets").catch(() => ({ items: [] as LabelSet[] })),
    ]);
    setUsers(u.items.filter((x) => !(x as unknown as { is_service?: number }).is_service)); setPipelines(p.items); setCustomFields(c.items.map((f) => { const set = f.settings?.label_set_id ? ls.items.find((x) => x.id === f.settings!.label_set_id) : null; return set ? { ...f, settings: { ...f.settings, labels: set.labels } } : f; })); setTeams(t.items); setSt(s.settings); setLabelSets(ls.items);
  }, []);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => { const h = () => onLogout(); window.addEventListener("crm:unauthorized", h); return () => window.removeEventListener("crm:unauthorized", h); }, [onLogout]);
  const can = (object: string, action: string) => !!me.role.permissions.admin || (Array.isArray(me.role.permissions[object]) && (me.role.permissions[object] as string[]).includes(action));
  const userName = (id: string | null | undefined) => users.find((u) => u.id === id)?.name ?? "";
  return <Ctx.Provider value={{ me, settings: st, users, pipelines, customFields, labelSets, teams, refresh, can, isAdmin: !!me.role.permissions.admin, userName }}>{children}</Ctx.Provider>;
}
