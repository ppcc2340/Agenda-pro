import type { Db } from "../db.js";
export function nextCounter(db: Db, ws: string, key: string): number {
  db.run("INSERT INTO counters (workspace_id, key, value) VALUES (?,?,0) ON CONFLICT(workspace_id,key) DO NOTHING", ws, key);
  db.run("UPDATE counters SET value=value+1 WHERE workspace_id=? AND key=?", ws, key);
  return db.get<{ value: number }>("SELECT value FROM counters WHERE workspace_id=? AND key=?", ws, key)?.value ?? 1;
}
