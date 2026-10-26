import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, unknown>;

export class Db {
  readonly sql: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
    this.sql.exec(schema);
    this.migrate();
  }
  /** Idempotent additive migrations for databases created with an older schema. */
  private migrate() {
    const add = (table: string, col: string, def: string) => {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (cols.length && !cols.includes(col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add("custom_fields", "settings", "TEXT NOT NULL DEFAULT '{}'");
    add("users", "is_service", "INTEGER NOT NULL DEFAULT 0");
    add("workflows", "owner_id", "TEXT");
    add("workflows", "priority", "INTEGER NOT NULL DEFAULT 100");
    add("workflows", "atomic", "INTEGER NOT NULL DEFAULT 0");
    add("workflows", "review_at", "TEXT");
    add("workflows", "paused_reason", "TEXT");
    add("workflows", "recipe", "TEXT");
    add("workflows", "last_period_key", "TEXT");
    add("workflow_runs", "actions_count", "INTEGER NOT NULL DEFAULT 0");
    add("workflow_runs", "trigger_desc", "TEXT");
    add("workflow_runs", "origin", "TEXT");
    add("workflow_runs", "depth", "INTEGER NOT NULL DEFAULT 0");
    add("workflow_runs", "error", "TEXT");
    add("workflow_runs", "duration_ms", "INTEGER");
    // registro de auditoría encadenado (solo INSERT): cada fila guarda el hash de la anterior del mismo espacio
    add("audit_log", "seq", "INTEGER");
    add("audit_log", "prev_hash", "TEXT");
    add("audit_log", "chain_hash", "TEXT");
    this.sql.exec("CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log es de solo inserción'); END;");
    this.sql.exec("CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log es de solo inserción'); END;");
    add("users", "recovery_codes", "TEXT");
    add("users", "password_changed_at", "TEXT");
    add("contacts", "emails", "TEXT NOT NULL DEFAULT '[]'");
    add("contacts", "phones", "TEXT NOT NULL DEFAULT '[]'");
    add("tasks", "recurrence_interval", "INTEGER NOT NULL DEFAULT 1");
    add("tasks", "recurrence_days", "TEXT");
    add("tasks", "duration_min", "INTEGER");
    add("tickets", "csat_token", "TEXT");
    add("tickets", "csat_comment", "TEXT");
    add("tickets", "csat_sent_at", "TEXT");
    // CLM configurable
    for (const [c, d] of [["intake_form", "TEXT NOT NULL DEFAULT '[]'"], ["number_format", "TEXT"], ["default_obligations", "TEXT NOT NULL DEFAULT '[]'"], ["default_milestones", "TEXT NOT NULL DEFAULT '[]'"], ["alert_config", "TEXT NOT NULL DEFAULT '{}'"]] as const) add("contract_types", c, d);
    for (const c of ["state_key", "state_entered_at", "state_due_at", "state_escalated_at"]) add("contracts", c, "TEXT");
    for (const c of ["approver_group", "group_mode", "expires_at", "rule_id", "substitute_for"]) add("contract_approvals", c, "TEXT");
    for (const c of ["acknowledged_at", "acknowledged_by", "first_alerted_at", "escalated_at"]) add("milestones", c, "TEXT");
    add("obligations", "alerted", "TEXT NOT NULL DEFAULT '[]'");
    add("custom_fields", "contract_type_id", "TEXT");
  }
  run(q: string, ...params: unknown[]) {
    return this.sql.prepare(q).run(...(params as never[]));
  }
  get<T = Row>(q: string, ...params: unknown[]): T | undefined {
    return this.sql.prepare(q).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(q: string, ...params: unknown[]): T[] {
    return this.sql.prepare(q).all(...(params as never[])) as T[];
  }
  private sp = 0;
  /** Nestable transaction (SAVEPOINT based): inner failures roll back only their own work. */
  transaction<T>(fn: () => T): T {
    const name = `sp${++this.sp}`;
    this.sql.exec(`SAVEPOINT ${name}`);
    try {
      const r = fn();
      this.sql.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      this.sql.exec(`ROLLBACK TO ${name}`);
      this.sql.exec(`RELEASE ${name}`);
      throw e;
    }
  }
  /** Insert a plain object into a table. JSON values are serialized. */
  insert(table: string, data: Row) {
    if (table === "audit_log") data = this.chainAudit(data);
    const keys = Object.keys(data);
    const vals = keys.map((k) => serialize(data[k]));
    this.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...vals);
  }
  /** Calcula seq, prev_hash y chain_hash = sha256(prev_hash | campos canónicos) para una fila de auditoría. */
  private chainAudit(data: Row): Row {
    const last = this.get<{ seq: number; chain_hash: string }>("SELECT seq, chain_hash FROM audit_log WHERE workspace_id=? AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1", data.workspace_id);
    const seq = (last?.seq ?? 0) + 1; const prev = last?.chain_hash ?? "GENESIS";
    return { ...data, seq, prev_hash: prev, chain_hash: auditHash(prev, { ...data, seq }) };
  }
  /** Update: keys with value `undefined` are left untouched (use null to clear). */
  update(table: string, id: string, data: Row) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => serialize(data[k]));
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`, ...vals, id);
  }
  close() {
    this.sql.close();
  }
}

export function serialize(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

/** Parse JSON columns on a row (in place, returns row). */
export function parseJson<T extends Row>(row: T | undefined, cols: string[]): T | undefined {
  if (!row) return row;
  for (const c of cols) {
    const v = row[c];
    if (typeof v === "string") {
      try {
        (row as Row)[c] = JSON.parse(v);
      } catch {
        /* keep as string */
      }
    }
  }
  return row;
}

/** Hash de una fila de auditoría (orden de campos fijo para que la verificación sea reproducible). */
export function auditHash(prev: string, r: Row): string {
  const changes = typeof r.changes === "string" ? r.changes : JSON.stringify(r.changes ?? {});
  const canon = [r.seq, r.id, r.workspace_id, r.user_id ?? "", r.object, r.record_id ?? "", r.action, changes, r.ip ?? "", r.created_at].join("\u001f");
  return createHash("sha256").update(`${prev}|${canon}`).digest("hex");
}
