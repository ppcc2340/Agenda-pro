import { decryptEnvelopeToString, encryptEnvelope } from "@meri/config/crypto";
import {
  audit,
  deleteCalendarEventByExternalId,
  findCalendarEventEtags,
  getEncryptedTokens,
  getIntegrationAccount,
  getSyncCursor,
  purgeCalendarEvents,
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
  type CalendarEvent,
  type CalendarProvider,
  type OAuthTokens,
} from "@meri/integrations";
import { resolveClient } from "@meri/core";
import type { HandlerDeps } from "./context";
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

/** AAD binds the token blob to its row so ciphertexts cannot be swapped between accounts (docs/06 §2). */
export const tokenAad = (workspaceId: string, accountId: string) =>
  `integration_account:${workspaceId}:${accountId}`;

export async function encryptTokens(
  deps: Pick<HandlerDeps, "keys">,
  workspaceId: string,
  accountId: string,
  tokens: OAuthTokens,
): Promise<string> {
  return encryptEnvelope(deps.keys, JSON.stringify(tokens), tokenAad(workspaceId, accountId));
}

export async function readTokens(
  deps: Pick<HandlerDeps, "db" | "keys">,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<OAuthTokens | null> {
  const row = await withWorkspace(deps.db, workspaceId, (tx) =>
    getEncryptedTokens(tx, workspaceId, accountId),
  );
  if (!row) return null;
  const json = await decryptEnvelopeToString(
    deps.keys,
    row.encryptedTokens,
    tokenAad(workspaceId, accountId),
  );
  return JSON.parse(json) as OAuthTokens;
}

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
  const tokens = await readTokens(deps, workspaceId, accountId);
  if (!tokens) return { status: "skipped", upserted: 0, removed: 0, fullResync: false };

  const calendar = deps.integrations.calendarFor(tokens.email);
  const range = {
    from: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000).toISOString(),
    to: new Date(now.getTime() + SYNC_FUTURE_DAYS * 86_400_000).toISOString(),
  };
  const result: CalendarSyncResult = { status: "synced", upserted: 0, removed: 0, fullResync: false };
  try {
    for (const cal of await calendar.listCalendars()) {
      const r = await syncOneCalendar(deps, workspaceId, accountId, calendar, cal.id, range, tokens.email);
      result.upserted += r.upserted;
      result.removed += r.removed;
      result.fullResync = result.fullResync || r.fullResync;
    }
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
      await withWorkspace(deps.db, workspaceId, async (tx) => {
        await setIntegrationStatus(tx, workspaceId, accountId, {
          status: "needs_reauth",
          lastError: "AuthExpired",
        });
        await audit(
          tx,
          { workspaceId, actor: "system" },
          {
            action: "integration.needs_reauth",
            entityType: "integration_account",
            entityId: accountId,
            reason: `${err.kind}: ${err.message.slice(0, 200)}`,
          },
        );
      });
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
