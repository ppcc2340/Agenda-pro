import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { notifications } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type NotificationKind = "digest" | "risk" | "proposals" | "plan" | "integration";

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  template: string;
  params: Record<string, string | number>;
  refs: { type: string; id: string }[];
  day: string;
  readAt: Date | null;
  createdAt: Date;
}

type Row = typeof notifications.$inferSelect;
const toView = (r: Row): NotificationView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export async function insertNotification(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: {
    kind: NotificationKind;
    title: string;
    body: string;
    template: string;
    params: Record<string, string | number>;
    refs: { type: string; id: string }[];
    day: string;
  },
  now: Date,
): Promise<NotificationView> {
  const [row] = await tx
    .insert(notifications)
    .values({ id: newId(), workspaceId, ...input, createdAt: now })
    .returning();
  if (!row) throw new Error("notification insert returned no row");
  return toView(row);
}

export async function countNotificationsForDay(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  day: string,
  kind?: NotificationKind,
): Promise<number> {
  const rows = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.day, day),
        kind ? eq(notifications.kind, kind) : undefined,
      ),
    );
  return rows.length;
}

export async function listNotifications(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  page: { limit: number; cursor?: string | undefined; unreadOnly?: boolean | undefined },
): Promise<{ items: NotificationView[]; nextCursor: string | null }> {
  const rows = await tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        page.unreadOnly ? isNull(notifications.readAt) : undefined,
        page.cursor ? lt(notifications.id, page.cursor) : undefined,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit).map(toView);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > page.limit && last ? last.id : null };
}

export async function markNotificationRead(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  now: Date,
): Promise<NotificationView | null> {
  const [row] = await tx
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.id, id)))
    .returning();
  return row ? toView(row) : null;
}
