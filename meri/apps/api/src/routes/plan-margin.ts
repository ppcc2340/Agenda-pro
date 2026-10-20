import { z } from "zod";
import { computeDailyMargin } from "@meri/core";
import type { CalendarEventView, PreferencesView, ScheduleBlockView } from "@meri/db";
import { toPlannerPreferences } from "@meri/jobs";

export const MarginView = z.object({
  day: z.string(),
  /** Reserve for the unexpected (never assigned). */
  minutes: z.number(),
  /** Where it is drawn: the tail of the day's last free stretch, never over a meeting or a block. */
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * D-051: the contingency reserve per local day, from the same capacity math as the planner (core) over the
 * preferences, the third-party events and the persisted blocks of the range. Not a planner run: nothing is
 * assigned or persisted.
 */
export function marginFor(
  prefs: PreferencesView | null,
  events: CalendarEventView[],
  blocks: ScheduleBlockView[],
  range: { now: Date; from: Date; to: Date },
): z.infer<typeof MarginView>[] {
  if (!prefs) return [];
  return computeDailyMargin({
    now: range.now.toISOString(),
    horizonStart: range.from.toISOString(),
    horizonEnd: range.to.toISOString(),
    tasks: [],
    // Meri's own mirrored events are represented by the blocks; only third-party events are fixed.
    fixedEvents: events
      .filter((e) => e.origin === "external")
      .map((e) => ({
        id: e.id,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        busy: e.busy && !e.allDay,
      })),
    existingBlocks: blocks.map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      pinned: b.pinned,
    })),
    preferences: toPlannerPreferences(prefs),
  });
}
