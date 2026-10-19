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
