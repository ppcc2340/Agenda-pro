import { and, desc, eq, lt } from "drizzle-orm";
import { auditLog } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newAuditId, type AuditId, type UserId, type WorkspaceId } from "../ids";

export type AuditActor = "user" | "system" | "ai";

export interface AuditContext {
  workspaceId: WorkspaceId;
  actor: AuditActor;
  actorUserId?: UserId | null;
}

export interface AuditEntryInput {
  action: string;
  entityType?: string;
  entityId?: string | null;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditEntry {
  id: AuditId;
  actor: AuditActor;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  undoneAt: Date | null;
  createdAt: Date;
}

/**
 * Append one immutable audit entry (F-14). Call it inside the same transaction as the change it describes
 * so an audit row never exists without its effect and vice versa.
 */
export async function audit(tx: WorkspaceTx, ctx: AuditContext, entry: AuditEntryInput): Promise<AuditId> {
  const id = newAuditId();
  await tx.insert(auditLog).values({
    id,
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    actorUserId: ctx.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    reason: entry.reason ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
  return id;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

/**
 * Cursor pagination, newest first. Ids are UUID v7 (time-ordered), so ordering by id is chronological and stable
 * even for rows created in the same transaction (identical created_at). The cursor is the id of the last row seen.
 */
export async function listAudit(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  limit: number,
  cursor?: string,
): Promise<AuditPage> {
  const rows = await tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), cursor ? lt(auditLog.id, cursor) : undefined))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id as AuditId,
    actor: r.actor,
    actorUserId: r.actorUserId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    reason: r.reason,
    before: r.before,
    after: r.after,
    undoneAt: r.undoneAt,
    createdAt: r.createdAt,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}
