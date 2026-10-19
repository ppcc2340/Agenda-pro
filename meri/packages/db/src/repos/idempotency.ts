import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "../schema";
import type { WorkspaceTx } from "../workspace";
import type { WorkspaceId } from "../ids";

export interface StoredResponse {
  requestHash: string;
  statusCode: number;
  response: unknown;
}

export async function getIdempotentResponse(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  key: string,
): Promise<StoredResponse | null> {
  const row = await tx.query.idempotencyKeys.findFirst({
    where: and(eq(idempotencyKeys.workspaceId, workspaceId), eq(idempotencyKeys.key, key)),
  });
  return row ? { requestHash: row.requestHash, statusCode: row.statusCode, response: row.response } : null;
}

/**
 * Reserves a key before the handler runs (status 0 = in progress). Returns `reserved: false` with the existing row
 * when the key is already taken, so concurrent duplicates never both execute (D-024).
 */
export async function reserveIdempotencyKey(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  key: string,
  requestHash: string,
  now: Date,
): Promise<{ reserved: true } | { reserved: false; existing: StoredResponse }> {
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ workspaceId, key, requestHash, statusCode: 0, response: null, createdAt: now })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { reserved: true };
  const existing = await getIdempotentResponse(tx, workspaceId, key);
  if (!existing) throw new Error("idempotency key vanished between insert and read");
  return { reserved: false, existing };
}

export async function finalizeIdempotencyKey(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  key: string,
  value: { statusCode: number; response: unknown },
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ statusCode: value.statusCode, response: value.response ?? null })
    .where(and(eq(idempotencyKeys.workspaceId, workspaceId), eq(idempotencyKeys.key, key)));
}

/** Drops a reservation whose request did not succeed, so the client may retry with the same key. */
export async function releaseIdempotencyKey(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  key: string,
): Promise<void> {
  await tx
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.workspaceId, workspaceId), eq(idempotencyKeys.key, key)));
}

export async function storeIdempotentResponse(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  key: string,
  value: StoredResponse,
  now: Date,
): Promise<void> {
  await tx
    .insert(idempotencyKeys)
    .values({
      workspaceId,
      key,
      requestHash: value.requestHash,
      statusCode: value.statusCode,
      response: value.response ?? null,
      createdAt: now,
    })
    .onConflictDoNothing();
}
