/**
 * briefings.prepare (D-043, ADR 0005): once a day, for every external meeting with a client that starts within
 * the look-ahead window, ONE notification "briefing.suggested" that deep-links to the client's briefing.
 * No AI runs here and no task is created; the briefing is generated only when the user opens it.
 */
import { localDateKey } from "@meri/core";
import {
  countNotificationsForDay,
  getPreferences,
  insertNotification,
  listCalendarEvents,
  listClients,
  notificationExistsForRef,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

/** Meetings starting within the next 2 days: with a daily run that is "one day before" give or take. */
export const BRIEFING_LOOKAHEAD_MS = 2 * 86_400_000;
export const BRIEFING_TEMPLATE = "briefing.suggested";

export interface BriefingsPrepareResult {
  status: "done" | "skipped";
  meetings: number;
  notified: number;
}

export async function prepareBriefings(deps: HandlerDeps, workspaceId: WorkspaceId): Promise<BriefingsPrepareResult> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs?.briefingBeforeMeetings) return { status: "skipped", meetings: 0, notified: 0 };
    const clients = await listClients(tx, workspaceId);
    const events = (
      await listCalendarEvents(tx, workspaceId, { from: now, to: new Date(now.getTime() + BRIEFING_LOOKAHEAD_MS) })
    ).filter((e) => e.origin === "external" && e.clientId !== null && !e.allDay && e.startsAt >= now);
    const day = localDateKey(now.getTime(), prefs.timezone);
    let notified = 0;
    for (const event of events) {
      const client = clients.find((c) => c.id === event.clientId);
      if (!client) continue;
      const ref = { type: "event", id: event.id };
      if (await notificationExistsForRef(tx, workspaceId, BRIEFING_TEMPLATE, ref)) continue;
      if ((await countNotificationsForDay(tx, workspaceId, day)) >= prefs.maxAlertsPerDay) break;
      await insertNotification(
        tx,
        workspaceId,
        {
          kind: "proposals",
          template: BRIEFING_TEMPLATE,
          params: { clientName: client.name, clientId: client.id, eventId: event.id, title: event.title ?? "" },
          title: `Briefing de ${client.name}`,
          body: `Reunión «${event.title ?? ""}» con ${client.name}: abre el briefing antes de ir.`,
          refs: [ref, { type: "client", id: client.id }],
          day,
        },
        now,
      );
      notified++;
    }
    return { status: "done", meetings: events.length, notified };
  });
}
