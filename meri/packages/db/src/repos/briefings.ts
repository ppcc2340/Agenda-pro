/** D-043: stored briefings, one per client and one per meeting; reused while the context hash is unchanged. */
import { and, eq, isNull, sql } from "drizzle-orm";
import { briefings } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface BriefingItemRow {
  claim: string;
  kind: string;
  sourceType: string;
  sourceId: string;
  url?: string;
  sourceTitle?: string;
}

export type BriefingView = Omit<typeof briefings.$inferSelect, "workspaceId" | "items"> & { items: BriefingItemRow[] };

const scope = (workspaceId: WorkspaceId, clientId: string, eventId: string | null) =>
  and(
    eq(briefings.workspaceId, workspaceId),
    eq(briefings.clientId, clientId),
    eventId ? eq(briefings.eventId, eventId) : isNull(briefings.eventId),
  );

export async function getBriefing(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  clientId: string,
  eventId: string | null,
): Promise<BriefingView | null> {
  const row = await tx.query.briefings.findFirst({ where: scope(workspaceId, clientId, eventId) });
  return row ?? null;
}

/** One statement: two concurrent generations for the same client/meeting cannot race the unique index. */
export async function upsertBriefing(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { clientId: string; eventId: string | null; items: BriefingItemRow[]; sourceHash: string; source: string },
  now: Date,
): Promise<BriefingView> {
  const values = { items: input.items, sourceHash: input.sourceHash, source: input.source, generatedAt: now };
  const [row] = await tx
    .insert(briefings)
    .values({ id: newId(), workspaceId, clientId: input.clientId, eventId: input.eventId, ...values, createdAt: now })
    .onConflictDoUpdate({
      target: input.eventId ? [briefings.workspaceId, briefings.clientId, briefings.eventId] : [briefings.workspaceId, briefings.clientId],
      targetWhere: input.eventId ? sql`${briefings.eventId} is not null` : sql`${briefings.eventId} is null`,
      set: values,
    })
    .returning();
  if (!row) throw new Error("briefing upsert returned no row");
  return row;
}
