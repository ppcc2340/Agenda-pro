import type { Db } from "../db.js";

export interface AssignmentRule { mode: "fixed" | "round_robin" | "least_loaded" | "none"; user_id?: string | null; team_id?: string | null }

/** Pick an owner for a new lead according to a rule (3.3). */
export function pickAssignee(db: Db, ws: string, rule: AssignmentRule | undefined, counterKey: string): string | null {
  if (!rule || rule.mode === "none") return null;
  if (rule.mode === "fixed") return rule.user_id ?? null;
  const users = db.all<{ id: string }>(`SELECT id FROM users WHERE workspace_id=? AND active=1${rule.team_id ? " AND team_id=?" : ""} ORDER BY created_at`, ...(rule.team_id ? [ws, rule.team_id] : [ws]));
  if (!users.length) return null;
  if (rule.mode === "least_loaded") {
    const loads = users.map((u) => ({ id: u.id, n: db.get<{ n: number }>("SELECT COUNT(*) n FROM contacts WHERE owner_id=? AND deleted_at IS NULL AND lifecycle_stage IN ('lead','mql','sql') AND lead_status IN ('new','contacted')", u.id)?.n ?? 0 }));
    loads.sort((a, b) => a.n - b.n);
    return loads[0]?.id ?? null;
  }
  // round robin: persistent counter per rule key
  db.run("INSERT INTO counters (workspace_id, key, value) VALUES (?,?,0) ON CONFLICT(workspace_id,key) DO NOTHING", ws, counterKey);
  db.run("UPDATE counters SET value=value+1 WHERE workspace_id=? AND key=?", ws, counterKey);
  const n = db.get<{ value: number }>("SELECT value FROM counters WHERE workspace_id=? AND key=?", ws, counterKey)?.value ?? 1;
  return users[(n - 1) % users.length]?.id ?? null;
}
