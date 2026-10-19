/**
 * time.infer (D-042): rules-only inference over the last `windowDays`. Idempotent by construction (one row per
 * source, ON CONFLICT DO NOTHING): a rejected entry is never resurrected and nothing is ever approved here.
 */
import { inferTimeEntries, ROUNDING_OPTIONS, type RoundingMinutes } from "@meri/core";
import {
  getPreferences,
  insertInferredEntries,
  listCalendarEvents,
  listCompletedBlocks,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export const TIME_INFER_WINDOW_DAYS = 21;

export interface TimeInferResult {
  status: "done" | "skipped";
  sources: number;
  inserted: number;
  unassignedEvents: number;
}

const roundingOf = (n: number): RoundingMinutes => (ROUNDING_OPTIONS.includes(n as RoundingMinutes) ? (n as RoundingMinutes) : 6);

export async function inferTime(deps: HandlerDeps, workspaceId: WorkspaceId): Promise<TimeInferResult> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs) return { status: "skipped", sources: 0, inserted: 0, unassignedEvents: 0 };
    const from = new Date(now.getTime() - TIME_INFER_WINDOW_DAYS * 86_400_000);
    const [events, blocks] = await Promise.all([
      listCalendarEvents(tx, workspaceId, { from, to: now }),
      listCompletedBlocks(tx, workspaceId, { from, to: now }),
    ]);
    const result = inferTimeEntries({
      now: now.toISOString(),
      timezone: prefs.timezone,
      roundingMinutes: roundingOf(prefs.timeRoundingMinutes),
      events: events.map((e) => ({
        id: e.id,
        clientId: e.clientId,
        title: e.title,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        allDay: e.allDay,
        busy: e.busy,
        origin: e.origin,
      })),
      blocks: blocks.map((b) => ({
        id: b.id,
        taskId: b.taskId,
        taskTitle: b.taskTitle,
        clientId: b.clientId,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      })),
    });
    const inserted = await insertInferredEntries(tx, workspaceId, result.entries, now);
    deps.logger.info({ workspaceId, sources: result.entries.length, inserted }, "time inferred");
    return { status: "done", sources: result.entries.length, inserted, unassignedEvents: result.unassignedEventIds.length };
  });
}
