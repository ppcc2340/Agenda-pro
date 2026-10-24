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
  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN");
    try {
      const r = fn();
      this.sql.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  /** Insert a plain object into a table. JSON values are serialized. */
  insert(table: string, data: Row) {
    const keys = Object.keys(data);
    const vals = keys.map((k) => serialize(data[k]));
    this.run(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...vals);
  }
  update(table: string, id: string, data: Row) {
    const keys = Object.keys(data);
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
