import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { commitments } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type CommitmentDirection = "owed_by_me" | "owed_to_me";
export type CommitmentKind = "explicit" | "inferred" | "suggested";
export type CommitmentStatus = "proposed" | "confirmed" | "fulfilled" | "at_risk" | "broken" | "dismissed";

export interface CommitmentView {
  id: string;
  clientId: string | null;
  direction: CommitmentDirection;
  kind: CommitmentKind;
  status: CommitmentStatus;
  counterpartyEmail: string | null;
  action: string;
  dueAt: Date | null;
  dueText: string | null;
  confidence: number | null;
  /** ≤ 200 characters, verified to exist verbatim in the source message (docs/05 §3.6). */
  evidence: string | null;
  threadId: string | null;
  externalMessageId: string | null;
  dedupeHash: string;
  taskId: string | null;
  origin: "user" | "ai_confirmed" | "system" | "integration";
  createdAt: Date;
  updatedAt: Date;
}

type Row = typeof commitments.$inferSelect;
const toView = (r: Row): CommitmentView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export interface NewCommitment {
  clientId: string | null;
  direction: CommitmentDirection;
  kind: CommitmentKind;
  status: CommitmentStatus;
  counterpartyEmail: string | null;
  action: string;
  dueAt: Date | null;
  dueText: string | null;
  confidence: number | null;
  evidence: string | null;
  threadId: string | null;
  externalMessageId: string | null;
  dedupeHash: string;
  origin?: CommitmentView["origin"];
}

/** Inserts unless the dedupe hash already exists in the workspace (docs/05 §3.9). Returns null on duplicate. */
export async function createCommitment(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: NewCommitment,
  now: Date,
): Promise<CommitmentView | null> {
  const [row] = await tx
    .insert(commitments)
    .values({
      id: newId(),
      workspaceId,
      ...input,
      origin: input.origin ?? "ai_confirmed",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [commitments.workspaceId, commitments.dedupeHash] })
    .returning();
  return row ? toView(row) : null;
}

export async function getCommitment(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<CommitmentView | null> {
  const row = await tx.query.commitments.findFirst({
    where: and(eq(commitments.workspaceId, workspaceId), eq(commitments.id, id)),
  });
  return row ? toView(row) : null;
}

export interface CommitmentFilters {
  direction?: CommitmentDirection | undefined;
  status?: CommitmentStatus | undefined;
  clientId?: string | undefined;
  /** Default: everything except proposed/dismissed. */
  includeProposed?: boolean | undefined;
}

export async function listCommitments(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  filters: CommitmentFilters,
  page: { limit: number; cursor?: string | undefined },
): Promise<{ items: CommitmentView[]; nextCursor: string | null }> {
  const rows = await tx
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.workspaceId, workspaceId),
        filters.direction ? eq(commitments.direction, filters.direction) : undefined,
        filters.status ? eq(commitments.status, filters.status) : undefined,
        filters.clientId ? eq(commitments.clientId, filters.clientId) : undefined,
        filters.status || filters.includeProposed
          ? undefined
          : sql`${commitments.status} not in ('proposed', 'dismissed')`,
        page.cursor ? lt(commitments.id, page.cursor) : undefined,
      ),
    )
    .orderBy(desc(commitments.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit).map(toView);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > page.limit && last ? last.id : null };
}

export async function updateCommitment(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: Partial<
    Pick<
      CommitmentView,
      "status" | "dueAt" | "dueText" | "clientId" | "action" | "taskId" | "counterpartyEmail" | "origin"
    >
  >,
  now: Date,
): Promise<CommitmentView | null> {
  const [row] = await tx
    .update(commitments)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(commitments.workspaceId, workspaceId), eq(commitments.id, id)))
    .returning();
  return row ? toView(row) : null;
}

/** Confirmed third-party commitments past due (F-08 AC1 input). */
export async function listOverdueOwedToMe(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  now: Date,
): Promise<CommitmentView[]> {
  const rows = await tx
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.workspaceId, workspaceId),
        eq(commitments.direction, "owed_to_me"),
        inArray(commitments.status, ["confirmed", "at_risk"]),
        lt(commitments.dueAt, now),
      ),
    )
    .orderBy(asc(commitments.dueAt));
  return rows.map(toView);
}

/** Open commitments of a thread (dedupe helper for the extraction pipeline). */
export async function listCommitmentHashes(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<Set<string>> {
  const rows = await tx
    .select({ hash: commitments.dedupeHash })
    .from(commitments)
    .where(eq(commitments.workspaceId, workspaceId));
  return new Set(rows.map((r) => r.hash));
}

/** Purge proposed commitments of an account's threads (disconnect, D-036). */
export async function purgeProposedCommitments(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  threadIds: string[],
): Promise<number> {
  if (threadIds.length === 0) return 0;
  const rows = await tx
    .delete(commitments)
    .where(
      and(
        eq(commitments.workspaceId, workspaceId),
        inArray(commitments.threadId, threadIds),
        or(eq(commitments.status, "proposed"), isNull(commitments.threadId)),
      ),
    )
    .returning({ id: commitments.id });
  return rows.length;
}
