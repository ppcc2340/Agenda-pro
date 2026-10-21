import {
  deleteCalendarEventByExternalId,
  findCalendarEventEtags,
  getIntegrationAccount,
  getSyncCursor,
  purgeCalendarEvents,
  purgeCalendarsExcept,
  setIntegrationStatus,
  setSyncCursor,
  upsertCalendarEvent,
  withWorkspace,
  type WorkspaceId,
  type WorkspaceTx,
  listClientRefs,
} from "@meri/db";
import {
  IntegrationError,
  hasCalendarScopes,
  type CalendarEvent,
  type CalendarProvider,
} from "@meri/integrations";
import { resolveClient } from "@meri/core";
import type { HandlerDeps } from "./context";
import { googleAccess, markNeedsReauth } from "../google-access";
import { track } from "../analytics";

/** One cursor per calendar, like Google's per-calendar syncToken. */
export const calendarResource = (calendarId: string) => `calendar.events:${calendarId}`;
/** Sync window: 7 days back, 60 days ahead (planner horizon). */
export const SYNC_PAST_DAYS = 7;
export const SYNC_FUTURE_DAYS = 60;

export interface CalendarSyncResult {
  status: "synced" | "needs_reauth" | "paused" | "skipped";
  upserted: number;
  removed: number;
  fullResync: boolean;
}

// Token helpers live in ../tokens (shared with google-access without an import cycle); re-exported for callers.
export { encryptTokens, readTokens, tokenAad } from "../tokens";

async function applyPage(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  accountId: string,
  calendarId: string,
  me: string,
  events: CalendarEvent[],
  now: Date,
): Promise<{ upserted: number; removed: number }> {
  let upserted = 0;
  let removed = 0;
  // D-040: an event belongs to a client when its attendees resolve unambiguously by domain or contact.
  const refs = await listClientRefs(tx, workspaceId);
  const known = await findCalendarEventEtags(
    tx,
    workspaceId,
    accountId,
    events.map((e) => e.externalId),
    calendarId,
  );
  for (const ev of events) {
    if (ev.status === "cancelled") {
      await deleteCalendarEventByExternalId(tx, workspaceId, accountId, ev.externalId, calendarId);
      removed++;
      continue;
    }
    await upsertCalendarEvent(
      tx,
      workspaceId,
      {
        integrationAccountId: accountId,
        calendarId,
        externalId: ev.externalId,
        etag: ev.etag,
        title: ev.title,
        startsAt: new Date(ev.startsAt),
        endsAt: new Date(ev.endsAt),
        allDay: ev.allDay,
        attendees: ev.attendees,
        busy: ev.busy,
        origin: ev.meri ? "meri" : "external",
        // D-040: never for Meri blocks nor all-day events (holidays, OOO) — only real meetings get a client.
        clientId: ev.meri || ev.allDay ? undefined : (resolveClient(ev.attendees, me, refs)?.id ?? null),
      },
      now,
    );
    // Unchanged etags are re-sent on full resyncs and by some providers: count only real changes.
    if (!known.has(ev.externalId) || known.get(ev.externalId) !== ev.etag) upserted++;
  }
  return { upserted, removed };
}

async function syncOneCalendar(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  accountId: string,
  calendar: CalendarProvider,
  calendarId: string,
  range: { from: string; to: string },
  me: string,
): Promise<{ upserted: number; removed: number; fullResync: boolean }> {
  const now = deps.now();
  const resource = calendarResource(calendarId);
  let cursor = await withWorkspace(deps.db, workspaceId, (tx) =>
    getSyncCursor(tx, workspaceId, accountId, resource),
  );
  let fullResync = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await calendar.sync({ calendarId, cursor, ...range });
    if (page.fullResyncRequired) {
      // 410 Gone: drop cursor and mirror of THIS calendar (ADR 0008), replay once from scratch (idempotent upserts).
      fullResync = true;
      cursor = null;
      await withWorkspace(deps.db, workspaceId, async (tx) => {
        await purgeCalendarEvents(tx, workspaceId, accountId, calendarId);
        await setSyncCursor(tx, workspaceId, accountId, resource, null, now);
      });
      continue;
    }
    const counts = await withWorkspace(deps.db, workspaceId, async (tx) => {
      const c = await applyPage(tx, workspaceId, accountId, calendarId, me, page.events, now);
      await setSyncCursor(tx, workspaceId, accountId, resource, page.nextCursor, now);
      return c;
    });
    return { ...counts, fullResync };
  }
  return { upserted: 0, removed: 0, fullResync };
}

/**
 * Incremental calendar sync (docs/07): per-calendar cursors, idempotent by external_id + etag, full resync on 410,
 * AuthExpired -> needs_reauth without touching stored data (F-04 AC3).
 */
async function failAccess(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  accountId: string,
  err: IntegrationError,
): Promise<CalendarSyncResult> {
  if (err.kind !== "AuthExpired") throw err;
  await withWorkspace(deps.db, workspaceId, (tx) => markNeedsReauth(tx, workspaceId, accountId, err, deps.now()));
  return { status: "needs_reauth", upserted: 0, removed: 0, fullResync: false };
}

export async function syncCalendarAccount(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<CalendarSyncResult> {
  const now = deps.now();
  const account = await withWorkspace(deps.db, workspaceId, (tx) =>
    getIntegrationAccount(tx, workspaceId, accountId),
  );
  if (!account) return { status: "skipped", upserted: 0, removed: 0, fullResync: false };
  if (account.status === "paused" || account.status === "revoked")
    return { status: "paused", upserted: 0, removed: 0, fullResync: false };
  // Gmail-only connection: nothing to mirror (calling Calendar would be a 403 read as an expired grant).
  if (!hasCalendarScopes(account.scopes))
    return { status: "skipped", upserted: 0, removed: 0, fullResync: false };
  let access;
  try {
    access = await googleAccess(deps, workspaceId, accountId);
  } catch (err) {
    // Unreadable tokens (key no longer configured): same as an expired grant, the user reconnects.
    if (err instanceof IntegrationError) return failAccess(deps, workspaceId, accountId, err);
    throw err;
  }
  if (!access) return { status: "skipped", upserted: 0, removed: 0, fullResync: false };

  const calendar = deps.integrations.calendarFor(access);
  const range = {
    from: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000).toISOString(),
    to: new Date(now.getTime() + SYNC_FUTURE_DAYS * 86_400_000).toISOString(),
  };
  const result: CalendarSyncResult = { status: "synced", upserted: 0, removed: 0, fullResync: false };
  try {
    const calendars = await calendar.listCalendars();
    for (const cal of calendars) {
      const r = await syncOneCalendar(deps, workspaceId, accountId, calendar, cal.id, range, access.email);
      result.upserted += r.upserted;
      result.removed += r.removed;
      result.fullResync = result.fullResync || r.fullResync;
    }
    // Calendars that left the list take their events (and their cursor) with them (review L9).
    await withWorkspace(deps.db, workspaceId, async (tx) => {
      const gone = await purgeCalendarsExcept(tx, workspaceId, accountId, calendars.map((c) => c.id));
      for (const id of gone) await setSyncCursor(tx, workspaceId, accountId, calendarResource(id), null, now);
    });
    await withWorkspace(deps.db, workspaceId, (tx) =>
      setIntegrationStatus(tx, workspaceId, accountId, {
        status: "healthy",
        lastError: null,
        lastSyncAt: now,
      }),
    );
    return result;
  } catch (err) {
    if (err instanceof IntegrationError)
      track(deps.integrations.analytics, "integration_error", workspaceId, {
        provider: "google",
        kind: err.kind,
      });
    if (err instanceof IntegrationError && err.kind === "AuthExpired") {
      await withWorkspace(deps.db, workspaceId, (tx) => markNeedsReauth(tx, workspaceId, accountId, err, deps.now()));
      return { ...result, status: "needs_reauth" };
    }
    if (err instanceof IntegrationError && err.retryable) {
      await withWorkspace(deps.db, workspaceId, (tx) =>
        setIntegrationStatus(tx, workspaceId, accountId, { status: "degraded", lastError: err.kind }),
      );
    }
    throw err;
  }
}
