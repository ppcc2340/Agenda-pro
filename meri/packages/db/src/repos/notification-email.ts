/**
 * Email copies of notifications (D-115): what the `notify.email` job reads and records. Everything runs inside the
 * workspace transaction (RLS); the job never sees another tenant's rows.
 */
import { and, eq, isNull } from "drizzle-orm";
import { memberships, notifications, users, workspaces } from "../schema";
import type { WorkspaceId } from "../ids";
import type { WorkspaceTx } from "../workspace";
import type { NotificationKind } from "./notifications";

export type EmailState = "sent" | "skipped" | "failed";

export interface EmailCandidate {
  id: string;
  kind: NotificationKind;
  template: string;
  params: Record<string, string | number>;
  emailState: EmailState | null;
  createdAt: Date;
}

export async function getNotificationForEmail(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<EmailCandidate | null> {
  const [row] = await tx
    .select({
      id: notifications.id,
      kind: notifications.kind,
      template: notifications.template,
      params: notifications.params,
      emailState: notifications.emailState,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.id, id)));
  return row ?? null;
}

/** Records the outcome once: false when another run already decided it. */
export async function markNotificationEmail(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  state: EmailState,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(notifications)
    .set({ emailState: state, emailedAt: state === "sent" ? now : null })
    .where(
      and(eq(notifications.workspaceId, workspaceId), eq(notifications.id, id), isNull(notifications.emailState)),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/** The workspace owner's address and language, or null when the owner or the workspace was deleted. */
export async function workspaceEmailRecipient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<{ userId: string; email: string; locale: string } | null> {
  const [row] = await tx
    .select({ userId: users.id, email: users.email, locale: users.locale })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, "owner"),
        isNull(users.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
