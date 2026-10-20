/**
 * GET /v1/value-report (F-12, D-063): three figures aggregated by `buildValueReport` from the workspace's own value
 * events; each with its unit, methods and sources. No events → `value: null`, never an invented zero.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  buildValueReport,
  fromLocalParts,
  isoWeekKey,
  isoWeekRange,
  toLocalParts,
  VALUE_METHODS,
} from "@meri/core";
import { getPreferences, listValueEvents } from "@meri/db";
import type { Analytics } from "@meri/integrations";
import { track } from "@meri/jobs";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const Source = z.object({
  type: z.string(),
  id: z.string(),
  label: z.string().nullable(),
  method: z.enum(VALUE_METHODS),
  quantity: z.number(),
  occurredAt: z.string(),
});
const Figure = z.object({
  key: z.enum(["commitments_saved", "deadline_risks_flagged", "hours_recovered"]),
  value: z.number().nullable(),
  unit: z.enum(["commitments", "deadlines", "hours"]),
  methods: z.array(z.enum(VALUE_METHODS)),
  estimated: z.boolean(),
  sources: z.array(Source),
});
const ValueReportView = z.object({
  period: z.enum(["week", "month"]),
  key: z.string(),
  from: z.string(),
  to: z.string(),
  figures: z.array(Figure),
});

/** [M9] `value_report_viewed` once per report and day; in-process and bounded (a restart may resend one). */
const VIEWED_CACHE_MAX = 5_000;

export interface ValueReportOptions {
  now: () => Date;
  analytics: Analytics;
}

/** Local calendar month containing `epochMs`: UTC bounds of day 1 00:00 and of the next month's day 1. */
function monthRange(epochMs: number, timeZone: string): { key: string; from: Date; to: Date } {
  const p = toLocalParts(epochMs, timeZone);
  const next = p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
  return {
    key: `${String(p.year)}-${String(p.month).padStart(2, "0")}`,
    from: new Date(fromLocalParts({ year: p.year, month: p.month, day: 1, hour: 0, minute: 0 }, timeZone)),
    to: new Date(fromLocalParts({ ...next, day: 1, hour: 0, minute: 0 }, timeZone)),
  };
}

export function valueReportRoutes(app: FastifyInstance, options: ValueReportOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const viewed = new Set<string>();

  r.get(
    "/v1/value-report",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        querystring: z.object({
          period: z.enum(["week", "month"]).default("week"),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
        response: { 200: ValueReportView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const { period } = request.query;
      const report = await request.withWorkspace(async (tx) => {
        const timezone = (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC";
        // The date is a local day; noon avoids any DST edge when mapping it to an instant.
        let at = now.getTime();
        if (request.query.date) {
          const [y, m, d] = request.query.date.split("-").map(Number) as [number, number, number];
          at = fromLocalParts({ year: y, month: m, day: d, hour: 12, minute: 0 }, timezone);
          if (Number.isNaN(at) || toLocalParts(at, timezone).day !== d)
            throw new ApiError("VALIDATION_FAILED", "Invalid date.");
        }
        const range =
          period === "week"
            ? (() => {
                const w = isoWeekRange(isoWeekKey(at, timezone), timezone);
                if (!w) throw new ApiError("VALIDATION_FAILED", "Invalid date.");
                return { key: w.key, from: w.from, to: w.to };
              })()
            : monthRange(at, timezone);
        const events = await listValueEvents(tx, session.workspaceId, range);
        const built = buildValueReport(events, range);
        return { period, key: range.key, from: built.from, to: built.to, figures: built.figures };
      });
      const viewKey = `${session.workspaceId}:${period}:${report.key}:${now.toISOString().slice(0, 10)}`;
      if (!viewed.has(viewKey)) {
        if (viewed.size >= VIEWED_CACHE_MAX) viewed.clear();
        viewed.add(viewKey);
        track(options.analytics, "value_report_viewed", session.workspaceId, { period });
      }
      return report;
    },
  );
  done();
}
