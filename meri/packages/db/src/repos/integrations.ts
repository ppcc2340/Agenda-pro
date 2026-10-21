import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { calendarEvents, integrationAccounts, scheduleBlocks, syncState } from "../schema";
import type { Db } from "../client";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export type ConnectionStatus = "healthy" | "needs_reauth" | "degraded" | "paused" | "revoked";

export interface IntegrationAccountView {
  id: string;
  provider: "google" | "microsoft" | "notion" | "slack";
  externalAccountId: string;
  email: string | null;
  scopes: string[];
  status: ConnectionStatus;
  keyId: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

type AccountRow = typeof integrationAccounts.$inferSelect;
const toAccount = (r: AccountRow): IntegrationAccountView => ({
  id: r.id,
  provider: r.provider,
  externalAccountId: r.externalAccountId,
  email: r.email,
  scopes: r.scopes,
  status: r.status,
  keyId: r.keyId,
  lastSyncAt: r.lastSyncAt,
  lastError: r.lastError,
  createdAt: r.createdAt,
});

export async function listIntegrationAccounts(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<IntegrationAccountView[]> {
  const rows = await tx
    .select()
    .from(integrationAccounts)
    .where(eq(integrationAccounts.workspaceId, workspaceId))
    .orderBy(asc(integrationAccounts.createdAt));
  return rows.map(toAccount);
}

export async function getIntegrationAccount(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<IntegrationAccountView | null> {
  const row = await tx.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.id, id)),
  });
  return row ? toAccount(row) : null;
}

/** Ciphertext is read only by the sync services; never returned by the API. */
export async function getEncryptedTokens(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<{ encryptedTokens: string; keyId: string } | null> {
  const row = await tx.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.id, id)),
    columns: { encryptedTokens: true, keyId: true },
  });
  return row ?? null;
}

/**
 * Every connection that still holds tokens, across workspaces (key rotation, ADR 0007). Only readable through the
 * admin read context (D-037): call it on an admin connection with `app.workspace_id = '*'`.
 */
export async function listTokenHoldingAccounts(db: Db): Promise<{ id: string; workspaceId: string }[]> {
  return db
    .select({ id: integrationAccounts.id, workspaceId: integrationAccounts.workspaceId })
    .from(integrationAccounts)
    .where(ne(integrationAccounts.status, "revoked"))
    .orderBy(integrationAccounts.workspaceId, integrationAccounts.id);
}

/**
 * Key rotation write (ADR 0007): replaces the ciphertext only if it is still the one that was read, so a token
 * refresh committed in between is never overwritten. Returns false on a lost race (the caller re-reads).
 */
export async function swapEncryptedTokens(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  change: { expected: string; next: string; keyId: string },
): Promise<boolean> {
  const rows = await tx
    .update(integrationAccounts)
    .set({ encryptedTokens: change.next, keyId: change.keyId })
    .where(
      and(
        eq(integrationAccounts.workspaceId, workspaceId),
        eq(integrationAccounts.id, id),
        eq(integrationAccounts.encryptedTokens, change.expected),
      ),
    )
    .returning({ id: integrationAccounts.id });
  return rows.length === 1;
}

export async function upsertIntegrationAccount(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: {
    provider: "google";
    externalAccountId: string;
    email: string;
    scopes: string[];
    encryptedTokens: string;
    keyId: string;
  },
  now: Date,
): Promise<IntegrationAccountView> {
  const [row] = await tx
    .insert(integrationAccounts)
    .values({ id: newId(), workspaceId, ...input, status: "healthy", lastError: null, createdAt: now })
    .onConflictDoUpdate({
      target: [
        integrationAccounts.workspaceId,
        integrationAccounts.provider,
        integrationAccounts.externalAccountId,
      ],
      set: {
        email: input.email,
        // Incremental authorization: scopes accumulate across consents (ADR 0004 §1).
        scopes: sql`(select array_to_json(array(select distinct jsonb_array_elements_text(${integrationAccounts.scopes} || ${JSON.stringify(input.scopes)}::jsonb)))::jsonb)`,
        encryptedTokens: input.encryptedTokens,
        keyId: input.keyId,
        status: "healthy",
        lastError: null,
      },
    })
    .returning();
  if (!row) throw new Error("integration account upsert returned no row");
  return toAccount(row);
}

export async function setIntegrationStatus(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: {
    status?: ConnectionStatus;
    lastError?: string | null;
    lastSyncAt?: Date | null;
    encryptedTokens?: string;
    keyId?: string;
  },
): Promise<IntegrationAccountView | null> {
  const [row] = await tx
    .update(integrationAccounts)
    .set(patch)
    .where(and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.id, id)))
    .returning();
  return row ? toAccount(row) : null;
}

/** Disconnect: purge the account, its sync cursors and mirrored events; Meri blocks lose their calendar link. */
export async function deleteIntegrationAccount(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<boolean> {
  const events = await tx
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.integrationAccountId, id)));
  if (events.length > 0) {
    for (const e of events) {
      await tx
        .update(scheduleBlocks)
        .set({ calendarEventId: null })
        .where(and(eq(scheduleBlocks.workspaceId, workspaceId), eq(scheduleBlocks.calendarEventId, e.id)));
    }
    await tx
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.integrationAccountId, id)));
  }
  await tx
    .delete(syncState)
    .where(and(eq(syncState.workspaceId, workspaceId), eq(syncState.integrationAccountId, id)));
  const deleted = await tx
    .delete(integrationAccounts)
    .where(and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.id, id)))
    .returning({ id: integrationAccounts.id });
  return deleted.length > 0;
}

// ---------- Sync cursors ----------
export async function getSyncCursor(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  resource: string,
): Promise<string | null> {
  const row = await tx.query.syncState.findFirst({
    where: and(
      eq(syncState.workspaceId, workspaceId),
      eq(syncState.integrationAccountId, accountId),
      eq(syncState.resource, resource),
    ),
  });
  return row?.cursor ?? null;
}

export async function setSyncCursor(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  resource: string,
  cursor: string | null,
  now: Date,
): Promise<void> {
  await tx
    .insert(syncState)
    .values({ workspaceId, integrationAccountId: accountId, resource, cursor, updatedAt: now })
    .onConflictDoUpdate({
      target: [syncState.integrationAccountId, syncState.resource],
      set: { cursor, updatedAt: now },
    });
}

// ---------- Calendar events mirror ----------
export interface CalendarEventView {
  id: string;
  integrationAccountId: string | null;
  externalId: string;
  etag: string | null;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: string[];
  clientId: string | null;
  origin: "meri" | "external";
  busy: boolean;
}

type EventRow = typeof calendarEvents.$inferSelect;
const toEvent = (r: EventRow): CalendarEventView => {
  const { workspaceId: _ws, updatedAt: _u, ...rest } = r;
  return rest;
};

export interface UpsertEventInput {
  integrationAccountId: string;
  /** Provider calendar id (default "primary"); part of the identity of an event (ADR 0008). */
  calendarId?: string;
  externalId: string;
  etag: string | null;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: string[];
  busy: boolean;
  origin: "meri" | "external";
  /** Resolved by attendees' domains/contacts (D-040); undefined keeps the stored value. */
  clientId?: string | null;
}

/** Idempotent by (workspace, account, calendar, external_id); a stale etag never overwrites a newer row (docs/07). */
export async function upsertCalendarEvent(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: UpsertEventInput,
  now: Date,
): Promise<CalendarEventView> {
  const [row] = await tx
    .insert(calendarEvents)
    .values({ id: newId(), workspaceId, ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        calendarEvents.workspaceId,
        calendarEvents.integrationAccountId,
        calendarEvents.calendarId,
        calendarEvents.externalId,
      ],
      set: {
        etag: input.etag,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        allDay: input.allDay,
        attendees: input.attendees,
        busy: input.busy,
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("calendar event upsert returned no row");
  return toEvent(row);
}

/** Known etags for a batch of external ids (so a sync counts only real changes). */
export async function findCalendarEventEtags(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  externalIds: string[],
  calendarId = "primary",
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (externalIds.length === 0) return map;
  const rows = await tx
    .select({ externalId: calendarEvents.externalId, etag: calendarEvents.etag })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        eq(calendarEvents.integrationAccountId, accountId),
        eq(calendarEvents.calendarId, calendarId),
        inArray(calendarEvents.externalId, externalIds),
      ),
    );
  for (const r of rows) map.set(r.externalId, r.etag);
  return map;
}

export async function deleteCalendarEventById(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<void> {
  await tx
    .delete(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, id)));
}

export async function deleteCalendarEventByExternalId(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  externalId: string,
  calendarId = "primary",
): Promise<void> {
  await tx
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        eq(calendarEvents.integrationAccountId, accountId),
        eq(calendarEvents.calendarId, calendarId),
        eq(calendarEvents.externalId, externalId),
      ),
    );
}

/** Full resync of one calendar (410 Gone): only that calendar's mirror is dropped, never the account's others. */
export async function purgeCalendarEvents(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  calendarId: string,
): Promise<void> {
  await tx
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        eq(calendarEvents.integrationAccountId, accountId),
        eq(calendarEvents.calendarId, calendarId),
      ),
    );
}

/** Remembers the dedicated «Meri» calendar of a connection (ADR 0008). */
export async function setMeriCalendarId(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  calendarId: string,
): Promise<void> {
  await tx
    .update(integrationAccounts)
    .set({ meriCalendarId: calendarId })
    .where(and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.id, accountId)));
}

export async function listCalendarEvents(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  range: { from: Date; to: Date },
): Promise<CalendarEventView[]> {
  const rows = await tx
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        lte(calendarEvents.startsAt, range.to),
        gte(calendarEvents.endsAt, range.from),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id));
  return rows.map(toEvent);
}

export async function getCalendarEvent(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<CalendarEventView | null> {
  const row = await tx.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, id)),
  });
  return row ? toEvent(row) : null;
}
