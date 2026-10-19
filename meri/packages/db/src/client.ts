import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Underlying postgres.js client, exposed for graceful shutdown. */
  sql: postgres.Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  max?: number;
  /** Fail fast when the server is unreachable (seconds). */
  connectTimeout?: number;
}

/** Cheap connectivity check for readiness probes. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeout ?? 10,
    // Dates travel as ISO strings in UTC; the app never relies on the server timezone.
    transform: { undefined: null },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
