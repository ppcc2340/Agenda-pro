import { and, asc, eq, isNull } from "drizzle-orm";
import { clients } from "../schema";
import type { WorkspaceTx } from "../workspace";
import type { WorkspaceId } from "../ids";

export interface ClientSummary {
  id: string;
  name: string;
  color: string | null;
  domains: string[];
}

/** Active clients of the workspace (names feed the capture context; full CRUD arrives in phase 3). */
export async function listClients(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<ClientSummary[]> {
  const rows = await tx
    .select({ id: clients.id, name: clients.name, color: clients.color, domains: clients.domains })
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), isNull(clients.deletedAt), isNull(clients.archivedAt)))
    .orderBy(asc(clients.name));
  return rows;
}
