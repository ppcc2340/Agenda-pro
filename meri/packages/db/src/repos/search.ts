/** F-09 AC2 / P3-03 search: ILIKE over tasks, commitments and clients, bounded per type (pg_trgm is listed debt). */
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { clients, commitments, tasks } from "../schema";
import type { WorkspaceTx } from "../workspace";
import type { WorkspaceId } from "../ids";

export const SEARCH_LIMIT = 20;

export interface SearchHit {
  type: "task" | "commitment" | "client";
  id: string;
  title: string;
  clientId: string | null;
  status: string | null;
  date: Date | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchWorkspace(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  q: string,
  filters: { clientId?: string | undefined } = {},
): Promise<SearchHit[]> {
  const pattern = `%${escapeLike(q.trim())}%`;
  const [taskRows, commitmentRows, clientRows] = await Promise.all([
    tx
      .select({ id: tasks.id, title: tasks.title, clientId: tasks.clientId, status: tasks.status, date: tasks.dueAt })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          filters.clientId ? eq(tasks.clientId, filters.clientId) : undefined,
          ilike(tasks.title, pattern),
        ),
      )
      .orderBy(sql`${tasks.status} = 'completed'`, desc(tasks.createdAt))
      .limit(SEARCH_LIMIT),
    tx
      .select({ id: commitments.id, title: commitments.action, clientId: commitments.clientId, status: commitments.status, date: commitments.dueAt })
      .from(commitments)
      .where(
        and(
          eq(commitments.workspaceId, workspaceId),
          filters.clientId ? eq(commitments.clientId, filters.clientId) : undefined,
          sql`${commitments.status} not in ('proposed', 'dismissed')`,
          ilike(commitments.action, pattern),
        ),
      )
      .orderBy(desc(commitments.createdAt))
      .limit(SEARCH_LIMIT),
    filters.clientId
      ? Promise.resolve([])
      : tx
          .select({ id: clients.id, title: clients.name, clientId: clients.id, status: sql<string | null>`null`, date: sql<Date | null>`null` })
          .from(clients)
          .where(and(eq(clients.workspaceId, workspaceId), isNull(clients.deletedAt), isNull(clients.archivedAt), ilike(clients.name, pattern)))
          .orderBy(asc(clients.name))
          .limit(SEARCH_LIMIT),
  ]);
  return [
    ...clientRows.map((r) => ({ type: "client" as const, ...r })),
    ...taskRows.map((r) => ({ type: "task" as const, ...r })),
    ...commitmentRows.map((r) => ({ type: "commitment" as const, ...r })),
  ];
}
