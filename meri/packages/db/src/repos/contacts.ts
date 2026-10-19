import { and, asc, eq } from "drizzle-orm";
import { contacts, clients, mailExclusions } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface ContactView {
  id: string;
  clientId: string | null;
  email: string;
  name: string | null;
  muted: boolean;
  createdAt: Date;
}
type Row = typeof contacts.$inferSelect;
const toView = (r: Row): ContactView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export async function upsertContact(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { email: string; name?: string | null; clientId?: string | null },
): Promise<ContactView> {
  const email = input.email.toLowerCase();
  const existing = await tx.query.contacts.findFirst({
    where: and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email)),
  });
  if (existing) {
    if ((input.name && !existing.name) || (input.clientId && !existing.clientId)) {
      const [row] = await tx
        .update(contacts)
        .set({
          name: existing.name ?? input.name ?? null,
          clientId: existing.clientId ?? input.clientId ?? null,
        })
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, existing.id)))
        .returning();
      return toView(row ?? existing);
    }
    return toView(existing);
  }
  const [row] = await tx
    .insert(contacts)
    .values({ id: newId(), workspaceId, email, name: input.name ?? null, clientId: input.clientId ?? null })
    .returning();
  if (!row) throw new Error("contact insert returned no row");
  return toView(row);
}

export async function findContactByEmail(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  email: string,
): Promise<ContactView | null> {
  const row = await tx.query.contacts.findFirst({
    where: and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email.toLowerCase())),
  });
  return row ? toView(row) : null;
}

export async function listContacts(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<ContactView[]> {
  const rows = await tx
    .select()
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId))
    .orderBy(asc(contacts.email));
  return rows.map(toView);
}

export async function setContactMuted(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  muted: boolean,
): Promise<ContactView | null> {
  const [row] = await tx
    .update(contacts)
    .set({ muted })
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, id)))
    .returning();
  return row ? toView(row) : null;
}

export async function setClientFollowupsMuted(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  muted: boolean,
): Promise<boolean> {
  const rows = await tx
    .update(clients)
    .set({ followupsMuted: muted })
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.id, id)))
    .returning({ id: clients.id });
  return rows.length > 0;
}

export async function mutedClientIds(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<Set<string>> {
  const rows = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.followupsMuted, true)));
  return new Set(rows.map((r) => r.id));
}

// ---------- Mail exclusions (P2-13) ----------
export type MailExclusionKind = "sender" | "domain" | "label";
export interface MailExclusionView {
  id: string;
  kind: MailExclusionKind;
  value: string;
  createdAt: Date;
}

export async function listMailExclusions(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<MailExclusionView[]> {
  const rows = await tx
    .select()
    .from(mailExclusions)
    .where(eq(mailExclusions.workspaceId, workspaceId))
    .orderBy(asc(mailExclusions.kind), asc(mailExclusions.value));
  return rows.map(({ workspaceId: _ws, ...rest }) => rest);
}

export async function addMailExclusion(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { kind: MailExclusionKind; value: string },
): Promise<MailExclusionView> {
  const value = input.value.trim().toLowerCase();
  const [row] = await tx
    .insert(mailExclusions)
    .values({ id: newId(), workspaceId, kind: input.kind, value })
    .onConflictDoNothing()
    .returning();
  if (row) {
    const { workspaceId: _ws, ...rest } = row;
    return rest;
  }
  const existing = await tx.query.mailExclusions.findFirst({
    where: and(
      eq(mailExclusions.workspaceId, workspaceId),
      eq(mailExclusions.kind, input.kind),
      eq(mailExclusions.value, value),
    ),
  });
  if (!existing) throw new Error("exclusion vanished");
  const { workspaceId: _ws2, ...rest } = existing;
  return rest;
}

export async function removeMailExclusion(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .delete(mailExclusions)
    .where(and(eq(mailExclusions.workspaceId, workspaceId), eq(mailExclusions.id, id)))
    .returning({ id: mailExclusions.id });
  return rows.length > 0;
}
