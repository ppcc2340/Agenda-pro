import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { threadsIndex } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

/**
 * Minimal thread index (docs/03, docs/06 §5): ids, subject, participants and dates. No message bodies, ever.
 * The schema test `no-mail-bodies.test.ts` guards this.
 */
export interface ThreadView {
  id: string;
  integrationAccountId: string;
  externalThreadId: string;
  subject: string | null;
  participants: string[];
  clientId: string | null;
  lastMessageAt: Date | null;
  lastMessageFromMe: boolean | null;
  lastExternalMessageId: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

type Row = typeof threadsIndex.$inferSelect;
const toView = (r: Row): ThreadView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export interface UpsertThreadInput {
  integrationAccountId: string;
  externalThreadId: string;
  subject: string | null;
  participants: string[];
  clientId: string | null;
  lastMessageAt: Date;
  lastMessageFromMe: boolean;
  lastExternalMessageId: string;
}

/** Idempotent by (workspace, account, external thread id); a newer message moves `lastMessageAt` forward. */
export async function upsertThread(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: UpsertThreadInput,
): Promise<{ thread: ThreadView; changed: boolean }> {
  const existing = await tx.query.threadsIndex.findFirst({
    where: and(
      eq(threadsIndex.workspaceId, workspaceId),
      eq(threadsIndex.integrationAccountId, input.integrationAccountId),
      eq(threadsIndex.externalThreadId, input.externalThreadId),
    ),
  });
  if (!existing) {
    const [row] = await tx
      .insert(threadsIndex)
      .values({ id: newId(), workspaceId, ...input })
      .returning();
    if (!row) throw new Error("thread insert returned no row");
    return { thread: toView(row), changed: true };
  }
  const newer = !existing.lastMessageAt || input.lastMessageAt > existing.lastMessageAt;
  if (!newer) return { thread: toView(existing), changed: false };
  const participants = [...new Set([...existing.participants, ...input.participants])];
  const [row] = await tx
    .update(threadsIndex)
    .set({
      subject: existing.subject ?? input.subject,
      participants,
      clientId: existing.clientId ?? input.clientId,
      lastMessageAt: input.lastMessageAt,
      lastMessageFromMe: input.lastMessageFromMe,
      lastExternalMessageId: input.lastExternalMessageId,
      processedAt: null, // new content: the extraction job runs again (dedupe hash prevents duplicates)
    })
    .where(and(eq(threadsIndex.workspaceId, workspaceId), eq(threadsIndex.id, existing.id)))
    .returning();
  return { thread: toView(row ?? existing), changed: true };
}

export async function getThread(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<ThreadView | null> {
  const row = await tx.query.threadsIndex.findFirst({
    where: and(eq(threadsIndex.workspaceId, workspaceId), eq(threadsIndex.id, id)),
  });
  return row ? toView(row) : null;
}

export async function getThreadsByIds(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
): Promise<Map<string, ThreadView>> {
  const map = new Map<string, ThreadView>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select()
    .from(threadsIndex)
    .where(and(eq(threadsIndex.workspaceId, workspaceId), inArray(threadsIndex.id, ids)));
  for (const r of rows) map.set(r.id, toView(r));
  return map;
}

export async function markThreadProcessed(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  now: Date,
): Promise<void> {
  await tx
    .update(threadsIndex)
    .set({ processedAt: now })
    .where(and(eq(threadsIndex.workspaceId, workspaceId), eq(threadsIndex.id, id)));
}

/** Threads sent by me with no reply for `days` (F-08 "sin respuesta"). */
export async function listUnansweredThreads(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  olderThan: Date,
): Promise<ThreadView[]> {
  const rows = await tx
    .select()
    .from(threadsIndex)
    .where(
      and(
        eq(threadsIndex.workspaceId, workspaceId),
        eq(threadsIndex.lastMessageFromMe, true),
        lt(threadsIndex.lastMessageAt, olderThan),
      ),
    )
    .orderBy(asc(threadsIndex.lastMessageAt));
  return rows.map(toView);
}

export async function listThreads(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  page: { limit: number },
): Promise<ThreadView[]> {
  const rows = await tx
    .select()
    .from(threadsIndex)
    .where(eq(threadsIndex.workspaceId, workspaceId))
    .orderBy(desc(threadsIndex.lastMessageAt))
    .limit(page.limit);
  return rows.map(toView);
}

export async function purgeAccountThreads(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<number> {
  const rows = await tx
    .delete(threadsIndex)
    .where(and(eq(threadsIndex.workspaceId, workspaceId), eq(threadsIndex.integrationAccountId, accountId)))
    .returning({ id: threadsIndex.id });
  return rows.length;
}

export async function listThreadIdsForAccount(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: threadsIndex.id })
    .from(threadsIndex)
    .where(and(eq(threadsIndex.workspaceId, workspaceId), eq(threadsIndex.integrationAccountId, accountId)));
  return rows.map((r) => r.id);
}

/** Threads whose last message is older than `before` (retention, D-036). */
export async function listThreadIdsOlderThan(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  before: Date,
  limit = 500,
): Promise<string[]> {
  const rows = await tx
    .select({ id: threadsIndex.id })
    .from(threadsIndex)
    .where(and(eq(threadsIndex.workspaceId, workspaceId), lt(threadsIndex.lastMessageAt, before)))
    .orderBy(asc(threadsIndex.lastMessageAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function deleteThreadsByIds(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .delete(threadsIndex)
    .where(and(eq(threadsIndex.workspaceId, workspaceId), inArray(threadsIndex.id, ids)))
    .returning({ id: threadsIndex.id });
  return rows.length;
}
