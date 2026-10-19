import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "./schema";
import type { Db } from "./client";
import { WorkspaceId } from "./ids";

export type WorkspaceTx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Run `fn` inside a transaction whose RLS context is the given workspace.
 * `SET LOCAL` (set_config(..., true)) is transaction-scoped, so the context can never leak to another request.
 * Every request and every job must go through here before touching tenant data (docs/03 §Reglas 2).
 */
export async function withWorkspace<T>(
  db: Db,
  workspaceId: string,
  fn: (tx: WorkspaceTx) => Promise<T>,
): Promise<T> {
  const id = WorkspaceId.parse(workspaceId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${id}, true)`);
    return fn(tx);
  });
}

/**
 * Serializes plan writers of one workspace (replan, accept, undo, confirm): a transaction-scoped advisory lock,
 * released at commit/rollback. Call it first inside `withWorkspace`.
 */
export async function lockWorkspace(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
}
