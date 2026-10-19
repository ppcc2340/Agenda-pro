import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { proposals } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type ProposalKind =
  "capture" | "commitment" | "followup" | "reschedule" | "time_entry" | "client_link";
export type ProposalStatus = "pending" | "confirmed" | "edited" | "dismissed" | "expired";

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  payload: Record<string, unknown>;
  confidence: number | null;
  explanation: string | null;
  sourceRef: { type: string; id: string; url?: string } | null;
  resolution: { action: string; editedPayload?: Record<string, unknown> } | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

type Row = typeof proposals.$inferSelect;
const toView = (r: Row): ProposalView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export interface NewProposal {
  kind: ProposalKind;
  payload: Record<string, unknown>;
  confidence?: number | null;
  explanation?: string | null;
  sourceRef?: { type: string; id: string; url?: string } | null;
}

export async function createProposal(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: NewProposal,
  now: Date,
): Promise<ProposalView> {
  const [row] = await tx
    .insert(proposals)
    .values({
      id: newId(),
      workspaceId,
      kind: input.kind,
      payload: input.payload,
      confidence: input.confidence ?? null,
      explanation: input.explanation ?? null,
      sourceRef: input.sourceRef ?? null,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("proposal insert returned no row");
  return toView(row);
}

export async function getProposal(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<ProposalView | null> {
  const row = await tx.query.proposals.findFirst({
    where: and(eq(proposals.workspaceId, workspaceId), eq(proposals.id, id)),
  });
  return row ? toView(row) : null;
}

export async function listProposals(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  filters: { status?: ProposalStatus | undefined; kind?: ProposalKind | undefined },
  page: { limit: number; cursor?: string | undefined },
): Promise<{ items: ProposalView[]; nextCursor: string | null }> {
  const rows = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        filters.status ? eq(proposals.status, filters.status) : undefined,
        filters.kind ? eq(proposals.kind, filters.kind) : undefined,
        page.cursor ? lt(proposals.id, page.cursor) : undefined,
      ),
    )
    .orderBy(desc(proposals.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit).map(toView);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > page.limit && last ? last.id : null };
}

export async function resolveProposal(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  resolution: {
    status: Exclude<ProposalStatus, "pending">;
    action: string;
    editedPayload?: Record<string, unknown>;
  },
  now: Date,
): Promise<ProposalView | null> {
  const [row] = await tx
    .update(proposals)
    .set({
      status: resolution.status,
      resolution: {
        action: resolution.action,
        ...(resolution.editedPayload ? { editedPayload: resolution.editedPayload } : {}),
      },
      resolvedAt: now,
    })
    .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.id, id), eq(proposals.status, "pending")))
    .returning();
  return row ? toView(row) : null;
}

/** Expire every pending proposal of a kind (e.g. older reschedule diffs after a new replan, ADR 0003). */
export async function expirePending(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  kind: ProposalKind,
  now: Date,
): Promise<number> {
  const pending = await tx
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(eq(proposals.workspaceId, workspaceId), eq(proposals.kind, kind), eq(proposals.status, "pending")),
    )
    .orderBy(asc(proposals.id));
  const ids = pending.map((p) => p.id);
  if (ids.length === 0) return 0;
  await tx
    .update(proposals)
    .set({ status: "expired", resolution: { action: "expired" }, resolvedAt: now })
    .where(and(eq(proposals.workspaceId, workspaceId), inArray(proposals.id, ids)));
  return ids.length;
}

export async function countPending(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(proposals)
    .where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.status, "pending")));
  return row?.n ?? 0;
}
