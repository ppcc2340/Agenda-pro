/**
 * GET /v1/reviews/daily?date= and GET /v1/reviews/weekly?week= (F-12, D-064): template reviews over the user's own
 * plan in their time zone; no AI. Defaults: today and the current ISO week.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isoWeekKey, localDateKey } from "@meri/core";
import { getPreferences } from "@meri/db";
import { loadDailyClose, loadWeeklyReview } from "@meri/jobs";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const Item = z.object({ taskId: z.string(), title: z.string(), clientId: z.string().nullable() });
const DailyView = z.object({
  date: z.string(),
  done: z.array(Item),
  pending: z.array(Item),
  toReschedule: z.array(Item),
  blocked: z.array(Item),
  newRisks: z.array(Item),
  tomorrow: z.array(Item.extend({ startsAt: z.string() })),
});
const WeeklyView = z.object({
  week: z.string(),
  days: z.array(
    z.object({
      day: z.string(),
      capacityMinutes: z.number(),
      plannedMinutes: z.number(),
      completedMinutes: z.number(),
      load: z.number().nullable(),
    }),
  ),
  totals: z.object({ capacityMinutes: z.number(), plannedMinutes: z.number(), completedMinutes: z.number() }),
  estimates: z.array(
    Item.extend({ estimateMinutes: z.number(), actualMinutes: z.number(), deltaPct: z.number() }),
  ),
  medianEstimateErrorPct: z.number().nullable(),
  trend: z
    .object({
      previousPlannedMinutes: z.number(),
      previousCompletedMinutes: z.number(),
      plannedDeltaPct: z.number().nullable(),
    })
    .nullable(),
});

export function reviewRoutes(app: FastifyInstance, options: { now: () => Date }, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/reviews/daily",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        querystring: z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
        response: { 200: DailyView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      return request.withWorkspace(async (tx) => {
        const prefs = await getPreferences(tx, session.workspaceId);
        if (!prefs) throw new ApiError("NOT_FOUND", "Preferences not found.");
        const day = request.query.date ?? localDateKey(now.getTime(), prefs.timezone);
        const close = await loadDailyClose(tx, session.workspaceId, prefs, day, now);
        if (!close) throw new ApiError("VALIDATION_FAILED", "Invalid date.");
        return close;
      });
    },
  );

  r.get(
    "/v1/reviews/weekly",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        querystring: z.object({
          week: z
            .string()
            .regex(/^\d{4}-W\d{2}$/)
            .optional(),
        }),
        response: { 200: WeeklyView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      return request.withWorkspace(async (tx) => {
        const prefs = await getPreferences(tx, session.workspaceId);
        if (!prefs) throw new ApiError("NOT_FOUND", "Preferences not found.");
        const week = request.query.week ?? isoWeekKey(now.getTime(), prefs.timezone);
        const review = await loadWeeklyReview(tx, session.workspaceId, prefs, week);
        if (!review) throw new ApiError("VALIDATION_FAILED", "Invalid week.");
        return review;
      });
    },
  );
  done();
}
