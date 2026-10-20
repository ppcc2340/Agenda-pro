import { createHash } from "node:crypto";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { workspaces } from "./schema";
import { UserId, type WorkspaceId } from "./ids";

/**
 * F-16 erasure (ADR 0007). Every table is classified so the deletion check can never silently miss one: a new
 * table without a classification fails `purge.test.ts`.
 * - `workspace`: rows belong to one workspace (`workspace_id`, or `id` for `workspaces` itself): all removed.
 * - `user`: the person (`users`): removed when they keep no other workspace.
 * - `global`: no personal data (Stripe event ids and types, erasure receipts with a hashed id).
 */
export const TABLE_CLASSIFICATION = {
  ai_usage: "workspace",
  audit_log: "workspace",
  billing_rollups: "workspace",
  briefings: "workspace",
  calendar_events: "workspace",
  cancellation_feedback: "workspace",
  clients: "workspace",
  commitments: "workspace",
  contacts: "workspace",
  credit_grants: "workspace",
  entitlements: "workspace",
  feature_flags: "workspace",
  idempotency_keys: "workspace",
  integration_accounts: "workspace",
  mail_exclusions: "workspace",
  memberships: "workspace",
  notifications: "workspace",
  plan_runs: "workspace",
  preferences: "workspace",
  projects: "workspace",
  proposals: "workspace",
  schedule_blocks: "workspace",
  subscriptions: "workspace",
  sync_state: "workspace",
  task_dependencies: "workspace",
  tasks: "workspace",
  threads_index: "workspace",
  time_entries: "workspace",
  value_events: "workspace",
  workspaces: "workspace",
  users: "user",
  stripe_events: "global",
  deletion_receipts: "global",
} as const satisfies Record<string, "workspace" | "user" | "global">;
export type TableName = keyof typeof TABLE_CLASSIFICATION;

/** Days between the logical deletion and the physical purge (fixed in `purge_workspace()`, migration 0018). */
export const PURGE_AFTER_DAYS = 30;

/** Hash kept in `deletion_receipts`: no personal data, but a restore can recognise the workspace. */
export const deletionSubjectHash = (workspaceId: string): string =>
  createHash("sha256").update(`meri-deletion-v1:${workspaceId}`).digest("hex");

/** Workspaces whose logical deletion is older than the purge window (workspaces carry no RLS: app role reads). */
export async function listPurgeCandidates(db: Db, now: Date, limit = 500): Promise<WorkspaceId[]> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 86_400_000);
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, cutoff)))
    .orderBy(workspaces.deletedAt)
    .limit(limit);
  return rows.map((r) => r.id as WorkspaceId);
}

/** `undefined` when the workspace no longer exists (already purged); `null` when it is not deleted. */
export async function workspaceDeletedAt(db: Db, workspaceId: WorkspaceId): Promise<Date | null | undefined> {
  const [row] = await db
    .select({ deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ? row.deletedAt : undefined;
}

/** Calls the SECURITY DEFINER purge as the application role; returns the number of tenant rows removed. */
export async function purgeWorkspace(db: Db, workspaceId: WorkspaceId): Promise<number> {
  const rows = await db.execute(sql`select purge_workspace(${workspaceId}::uuid) as removed`);
  return Number((rows[0] as { removed: number | string } | undefined)?.removed ?? 0);
}

/**
 * Verification query (docs/compliance/deletion-verification.md): rows still referencing the workspace or its users,
 * per table. Run with an admin connection under the admin read context (`app.workspace_id = '*'`).
 */
export async function remainingPersonalRows(
  adminDb: Db,
  input: { workspaceId: string; userIds: string[] },
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const ids = input.userIds.map((id) => UserId.parse(id));
  // A Postgres array literal of validated uuids (drizzle would expand a JS array into a parameter list).
  const userArray = `{${ids.join(",")}}`;
  for (const [table, kind] of Object.entries(TABLE_CLASSIFICATION)) {
    if (kind === "global") continue;
    const query =
      table === "workspaces"
        ? sql`select count(*)::int as n from workspaces where id = ${input.workspaceId}::uuid`
        : table === "users"
          ? sql`select count(*)::int as n from users where id = any(${userArray}::uuid[])`
          : sql`select count(*)::int as n from ${sql.identifier(table)} where workspace_id = ${input.workspaceId}::uuid`;
    const rows = await adminDb.execute(query);
    out[table] = Number((rows[0] as { n: number } | undefined)?.n ?? 0);
  }
  const actor = await adminDb.execute(
    sql`select count(*)::int as n from audit_log where actor_user_id = any(${userArray}::uuid[])`,
  );
  out["audit_log.actor_user_id"] = Number((actor[0] as { n: number } | undefined)?.n ?? 0);
  return out;
}
