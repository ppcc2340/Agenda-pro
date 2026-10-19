/**
 * Writes Meri blocks to the user's calendar (ADR 0003 §3). Only events Meri created are ever touched;
 * the provider contract refuses to modify third-party events (docs/07).
 */
import {
  getCalendarEvent,
  listIntegrationAccounts,
  updateBlock,
  upsertCalendarEvent,
  withWorkspace,
  type ScheduleBlockView,
  type WorkspaceId,
} from "@meri/db";
import type { CalendarProvider } from "@meri/integrations";
import { readTokens } from "./calendar-sync";
import type { HandlerDeps } from "./context";

export interface CalendarWriteResult {
  created: number;
  deleted: number;
  /** Null when no healthy Google account exists (nothing written). */
  accountId: string | null;
}

async function healthyCalendar(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
): Promise<{ accountId: string; calendar: CalendarProvider } | null> {
  const accounts = await withWorkspace(deps.db, workspaceId, (tx) =>
    listIntegrationAccounts(tx, workspaceId),
  );
  const account = accounts.find((a) => a.provider === "google" && a.status === "healthy");
  if (!account) return null;
  const tokens = await readTokens(deps, workspaceId, account.id);
  if (!tokens) return null;
  return { accountId: account.id, calendar: deps.integrations.calendarFor(tokens.email) };
}

/**
 * Creates calendar events for `create` blocks (and links them through `calendar_event_id`) and cancels the events of
 * `remove` blocks. Failures are logged and never roll back the plan: the next sync reconciles the mirror.
 */
export async function writeBlocksToCalendar(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  changes: { create: ScheduleBlockView[]; remove: ScheduleBlockView[]; titles: Map<string, string> },
): Promise<CalendarWriteResult> {
  const result: CalendarWriteResult = { created: 0, deleted: 0, accountId: null };
  if (changes.create.length === 0 && changes.remove.length === 0) return result;
  const target = await healthyCalendar(deps, workspaceId);
  if (!target) return result;
  result.accountId = target.accountId;
  const now = deps.now();
  let calendarId: string;
  try {
    calendarId = await target.calendar.ensureMeriCalendar();
  } catch (err) {
    deps.logger.warn({ err, workspaceId }, "meri calendar unavailable; blocks kept locally");
    return result;
  }
  for (const block of changes.remove) {
    if (!block.calendarEventId) continue;
    try {
      const event = await withWorkspace(deps.db, workspaceId, (tx) =>
        getCalendarEvent(tx, workspaceId, block.calendarEventId ?? ""),
      );
      if (!event || event.origin !== "meri") continue;
      await target.calendar.deleteMeriEvent(calendarId, event.externalId);
      result.deleted++;
    } catch (err) {
      deps.logger.warn({ err, blockId: block.id }, "could not delete meri event");
    }
  }
  for (const block of changes.create) {
    try {
      const created = await target.calendar.createMeriEvent(calendarId, {
        title: changes.titles.get(block.taskId) ?? "Meri",
        startsAt: block.startsAt.toISOString(),
        endsAt: block.endsAt.toISOString(),
      });
      await withWorkspace(deps.db, workspaceId, async (tx) => {
        const mirrored = await upsertCalendarEvent(
          tx,
          workspaceId,
          {
            integrationAccountId: target.accountId,
            externalId: created.externalId,
            etag: created.etag,
            title: created.title,
            startsAt: new Date(created.startsAt),
            endsAt: new Date(created.endsAt),
            allDay: false,
            attendees: [],
            busy: true,
            origin: "meri",
          },
          now,
        );
        await updateBlock(tx, workspaceId, block.id, { calendarEventId: mirrored.id });
      });
      result.created++;
    } catch (err) {
      deps.logger.warn({ err, blockId: block.id }, "could not create meri event");
    }
  }
  return result;
}
