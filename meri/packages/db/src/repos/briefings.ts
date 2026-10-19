/** D-043: stored briefings, one per client and one per meeting; reused while the context hash is unchanged. */
import { and, eq, isNull } from "drizzle-orm";
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

export async function upsertBriefing(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { clientId: string; eventId: string | null; items: BriefingItemRow[]; sourceHash: string; source: string },
  now: Date,
): Promise<BriefingView> {
  const existing = await getBriefing(tx, workspaceId, input.clientId, input.eventId);
  const values = { items: input.items, sourceHash: input.sourceHash, source: input.source, generatedAt: now };
  if (existing) {
    const [row] = await tx.update(briefings).set(values).where(eq(briefings.id, existing.id)).returning();
    if (!row) throw new Error("briefing update returned no row");
    return row;
  }
  const [row] = await tx
    .insert(briefings)
    .values({ id: newId(), workspaceId, clientId: input.clientId, eventId: input.eventId, ...values, createdAt: now })
    .returning();
  if (!row) throw new Error("briefing insert returned no row");
  return row;
}
