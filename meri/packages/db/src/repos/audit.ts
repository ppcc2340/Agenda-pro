import { and, desc, eq, lt, inArray } from "drizzle-orm";
import { auditLog, clients, commitments, projects, tasks } from "../schema";
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
  /** For compensating rows (ADR 0003): the id of the entry being undone. */
  undoOfAuditId?: string | null;
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
  undoOfAuditId: string | null;
  /** Derived: timestamp of the compensating row, if any. */
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
    undoOfAuditId: entry.undoOfAuditId ?? null,
  });
  return id;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

type Row = typeof auditLog.$inferSelect;

async function undoneMap(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ undoOf: auditLog.undoOfAuditId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), inArray(auditLog.undoOfAuditId, ids)));
  for (const r of rows) if (r.undoOf) map.set(r.undoOf, r.createdAt);
  return map;
}

const toEntry = (r: Row, undone: Map<string, Date>): AuditEntry => ({
  id: r.id as AuditId,
  actor: r.actor,
  actorUserId: r.actorUserId,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  reason: r.reason,
  before: r.before,
  after: r.after,
  undoOfAuditId: r.undoOfAuditId,
  undoneAt: undone.get(r.id) ?? null,
  createdAt: r.createdAt,
});

export async function getAuditEntry(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<AuditEntry | null> {
  const row = await tx.query.auditLog.findFirst({
    where: and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, id)),
  });
  if (!row) return null;
  return toEntry(row, await undoneMap(tx, workspaceId, [row.id]));
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
  const slice = rows.slice(0, limit);
  const undone = await undoneMap(
    tx,
    workspaceId,
    slice.map((r) => r.id),
  );
  const items = slice.map((r) => toEntry(r, undone));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}

/** True when the workspace already has an audit entry with this action, optionally about one entity. */
export async function auditActionExists(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  action: string,
  entityId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.action, action),
        entityId ? eq(auditLog.entityId, entityId) : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Human labels of the entities an activity page mentions (P5-05): task and asunto titles, client names, commitment
 * actions — read in the caller's workspace (RLS), one query per type. Missing entities (deleted) get no label.
 */
export async function auditEntityLabels(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  entries: readonly Pick<AuditEntry, "entityType" | "entityId">[],
): Promise<Map<string, string>> {
  const idsOf = (type: string) =>
    [...new Set(entries.filter((e) => e.entityType === type && e.entityId).map((e) => e.entityId as string))];
  const labels = new Map<string, string>();
  const tasksIds = idsOf("task");
  if (tasksIds.length > 0)
    for (const r of await tx
      .select({ id: tasks.id, label: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, tasksIds))))
      labels.set(r.id, r.label);
  const clientIds = idsOf("client");
  if (clientIds.length > 0)
    for (const r of await tx
      .select({ id: clients.id, label: clients.name })
      .from(clients)
      .where(and(eq(clients.workspaceId, workspaceId), inArray(clients.id, clientIds))))
      labels.set(r.id, r.label);
  const projectIds = idsOf("project");
  if (projectIds.length > 0)
    for (const r of await tx
      .select({ id: projects.id, label: projects.name })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds))))
      labels.set(r.id, r.label);
  const commitmentIds = idsOf("commitment");
  if (commitmentIds.length > 0)
    for (const r of await tx
      .select({ id: commitments.id, label: commitments.action })
      .from(commitments)
      .where(and(eq(commitments.workspaceId, workspaceId), inArray(commitments.id, commitmentIds))))
      labels.set(r.id, r.label);
  return labels;
}
