/**
 * F-10 time review (D-042, D-046, ADR 0005): weekly entries per client (approved vs suggested), review actions
 * (approve / reject / batch / edit), unassigned meetings, and the CSV export. Only the user approves; the job
 * only suggests. `time.approved` is audited and undoable.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isoWeekKey, isoWeekRange, timeEntriesCsv, type TimeCsvRow } from "@meri/core";
import {
  audit,
  clientNamesById,
  getClient,
  getPreferences,
  getTimeEntriesByIds,
  getTimeEntry,
  listCalendarEvents,
  listProjects,
  listTimeEntries,
  setTimeEntriesStatus,
  updateTimeEntry,
  type TimeEntryView,
} from "@meri/db";
import type { Analytics } from "@meri/integrations";
import { track } from "@meri/jobs";
import { ApiError } from "../errors";
import { assertEntitlement } from "../plugins/entitlements";
import { requireSession, sessionOf } from "../plugins/session";

const IdParams = z.object({ id: z.string().uuid() });
const WEEK = z.string().regex(/^\d{4}-W\d{2}$/);
const TimeEntryJson = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  day: z.string(),
  minutes: z.number().int(),
  description: z.string().nullable(),
  status: z.enum(["suggested", "approved", "rejected", "exported"]),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  approvedAt: z.string().datetime().nullable(),
});
const WeekJson = z.object({
  week: z.string(),
  days: z.array(z.string()),
  items: z.array(TimeEntryJson),
  summary: z.array(
    z.object({
      clientId: z.string().nullable(),
      clientName: z.string().nullable(),
      minutesApproved: z.number().int(),
      minutesSuggested: z.number().int(),
    }),
  ),
  /** External meetings of the week without a client: "tiempo no registrado" (D-042). */
  unassignedEvents: z.array(
    z.object({ id: z.string(), title: z.string().nullable(), startsAt: z.string(), endsAt: z.string(), minutes: z.number().int() }),
  ),
});

export interface TimeRoutesOptions {
  now: () => Date;
  analytics: Analytics;
}

export function timeRoutes(app: FastifyInstance, options: TimeRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const serialize = (e: TimeEntryView, names: Map<string, string>) => ({
    id: e.id,
    clientId: e.clientId,
    clientName: e.clientId ? (names.get(e.clientId) ?? null) : null,
    projectId: e.projectId,
    taskId: e.taskId,
    day: e.day,
    minutes: e.minutes,
    description: e.description,
    status: e.status,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
  });
  const actor = (request: Parameters<typeof sessionOf>[0]) => {
    const s = sessionOf(request);
    return { workspaceId: s.workspaceId, actor: "user" as const, actorUserId: s.userId };
  };

  r.get(
    "/v1/time-entries",
    {
      preHandler: requireSession,
      schema: {
        tags: ["time"],
        querystring: z.object({
          week: WEEK.optional(),
          clientId: z.string().uuid().optional(),
          status: z.enum(["all"]).optional(),
        }),
        response: { 200: WeekJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      return request.withWorkspace(async (tx) => {
        const timezone = (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC";
        const week = isoWeekRange(request.query.week ?? isoWeekKey(now.getTime(), timezone), timezone);
        if (!week) throw new ApiError("VALIDATION_FAILED", "Invalid week.");
        const [items, names, events] = await Promise.all([
          listTimeEntries(tx, session.workspaceId, {
            from: week.days[0] ?? "",
            to: week.days[6] ?? "",
            clientId: request.query.clientId,
            includeRejected: request.query.status === "all",
          }),
          clientNamesById(tx, session.workspaceId),
          listCalendarEvents(tx, session.workspaceId, { from: week.from, to: week.to }),
        ]);
        const summary = new Map<string | null, { minutesApproved: number; minutesSuggested: number }>();
        for (const e of items) {
          const row = summary.get(e.clientId) ?? { minutesApproved: 0, minutesSuggested: 0 };
          if (e.status === "approved" || e.status === "exported") row.minutesApproved += e.minutes;
          else if (e.status === "suggested") row.minutesSuggested += e.minutes;
          summary.set(e.clientId, row);
        }
        const unassigned = events
          .filter((e) => e.origin === "external" && e.busy && !e.allDay && e.clientId === null && e.endsAt <= now)
          .map((e) => ({
            id: e.id,
            title: e.title,
            startsAt: e.startsAt.toISOString(),
            endsAt: e.endsAt.toISOString(),
            minutes: Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000),
          }));
        return {
          week: week.key,
          days: week.days,
          items: items.map((e) => serialize(e, names)),
          summary: [...summary.entries()]
            .map(([clientId, m]) => ({ clientId, clientName: clientId ? (names.get(clientId) ?? null) : null, ...m }))
            .sort((a, b) => (a.clientName ?? "").localeCompare(b.clientName ?? "")),
          unassignedEvents: request.query.clientId ? [] : unassigned,
        };
      });
    },
  );

  r.patch(
    "/v1/time-entries/:id",
    {
      preHandler: requireSession,
      schema: {
        tags: ["time"],
        params: IdParams,
        body: z.object({
          minutes: z.number().int().min(1).max(24 * 60).optional(),
          clientId: z.string().uuid().optional(),
          description: z.string().trim().max(300).nullable().optional(),
        }),
        response: { 200: TimeEntryJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const b = request.body;
      return request.withWorkspace(async (tx) => {
        const before = await getTimeEntry(tx, session.workspaceId, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Time entry not found.");
        if (b.clientId && !(await getClient(tx, session.workspaceId, b.clientId)))
          throw new ApiError("VALIDATION_FAILED", "Invalid references.", [{ path: "clientId", message: "Unknown client." }]);
        // An approved entry stays approved: the user is correcting it, not re-opening review (M10d).
        const updated = await updateTimeEntry(tx, session.workspaceId, before.id, {
          ...(b.minutes !== undefined ? { minutes: b.minutes } : {}),
          ...(b.clientId !== undefined ? { clientId: b.clientId } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
        });
        if (!updated) throw new ApiError("NOT_FOUND", "Time entry not found.");
        await audit(tx, actor(request), {
          action: "time.updated",
          entityType: "time_entry",
          entityId: updated.id,
          before: { minutes: before.minutes, clientId: before.clientId, description: before.description },
          after: { minutes: updated.minutes, clientId: updated.clientId, description: updated.description },
        });
        return serialize(updated, await clientNamesById(tx, session.workspaceId));
      });
    },
  );

  const review = async (
    request: Parameters<typeof sessionOf>[0],
    ids: string[],
    status: "approved" | "rejected",
  ) => {
    const session = sessionOf(request);
    const now = options.now();
    return request.withWorkspace(async (tx) => {
      const found = await getTimeEntriesByIds(tx, session.workspaceId, ids);
      const eligible = found.filter((e) => e.status === "suggested" || (status === "rejected" && e.status === "approved"));
      const updated = await setTimeEntriesStatus(
        tx,
        session.workspaceId,
        eligible.map((e) => e.id),
        status,
        now,
      );
      for (const e of updated) {
        const before = found.find((f) => f.id === e.id);
        await audit(tx, actor(request), {
          action: status === "approved" ? "time.approved" : "time.rejected",
          entityType: "time_entry",
          entityId: e.id,
          before: { status: before?.status ?? "suggested" },
          after: { status, minutes: e.minutes, clientId: e.clientId, day: e.day },
        });
      }
      const names = await clientNamesById(tx, session.workspaceId);
      return {
        updated: updated.map((e) => serialize(e, names)),
        skipped: ids.filter((id) => !updated.some((e) => e.id === id)).map((id) => ({
          id,
          reason: found.some((f) => f.id === id) ? "not_pending" : "not_found",
        })),
      };
    });
  };

  r.post(
    "/v1/time-entries/:id/approve",
    { preHandler: requireSession, schema: { tags: ["time"], params: IdParams, response: { 200: TimeEntryJson } } },
    async (request) => {
      const { updated, skipped } = await review(request, [request.params.id], "approved");
      const one = updated[0];
      if (!one) throw new ApiError(skipped[0]?.reason === "not_found" ? "NOT_FOUND" : "CONFLICT", "Entry is not pending review.");
      return one;
    },
  );

  r.post(
    "/v1/time-entries/:id/reject",
    { preHandler: requireSession, schema: { tags: ["time"], params: IdParams, response: { 200: TimeEntryJson } } },
    async (request) => {
      const { updated, skipped } = await review(request, [request.params.id], "rejected");
      const one = updated[0];
      if (!one) throw new ApiError(skipped[0]?.reason === "not_found" ? "NOT_FOUND" : "CONFLICT", "Entry cannot be rejected.");
      return one;
    },
  );

  r.post(
    "/v1/time-entries/approve-batch",
    {
      preHandler: requireSession,
      schema: {
        tags: ["time"],
        body: z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }),
        response: {
          200: z.object({
            approved: z.array(z.string()),
            skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const { updated, skipped } = await review(request, request.body.ids, "approved");
      return { approved: updated.map((e) => e.id), skipped };
    },
  );

  r.get(
    "/v1/time-entries/export.csv",
    {
      preHandler: requireSession,
      schema: {
        tags: ["time"],
        querystring: z.object({
          week: WEEK.optional(),
          /** [L13] Monthly export: Pro+ (`advanced_exports`); the weekly one stays on every plan. */
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
          clientId: z.string().uuid().optional(),
          status: z.enum(["all"]).optional(),
        }),
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const { csv, key, scope, entries } = await request.withWorkspace(async (tx) => {
        const timezone = (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC";
        let range: { from: string; to: string; key: string };
        if (request.query.month) {
          await assertEntitlement(tx, session.workspaceId, "advanced_exports");
          const [y, m] = request.query.month.split("-").map(Number) as [number, number];
          const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
          range = { from: `${request.query.month}-01`, to: `${request.query.month}-${String(last)}`, key: request.query.month };
        } else {
          const week = isoWeekRange(request.query.week ?? isoWeekKey(now.getTime(), timezone), timezone);
          if (!week) throw new ApiError("VALIDATION_FAILED", "Invalid week.");
          range = { from: week.days[0] ?? "", to: week.days[6] ?? "", key: week.key };
        }
        const [items, names, projects] = await Promise.all([
          listTimeEntries(tx, session.workspaceId, {
            from: range.from,
            to: range.to,
            clientId: request.query.clientId,
            includeRejected: request.query.status === "all",
          }),
          clientNamesById(tx, session.workspaceId),
          listProjects(tx, session.workspaceId),
        ]);
        // Export never mutates: `approved` rows stay `approved` (M10f); only approved rows unless status=all.
        const rows: TimeCsvRow[] = items
          .filter((e) => request.query.status === "all" || e.status === "approved" || e.status === "exported")
          .map((e) => ({
            day: e.day,
            clientName: e.clientId ? (names.get(e.clientId) ?? "") : "",
            projectName: e.projectId ? (projects.find((p) => p.id === e.projectId)?.name ?? "") : "",
            description: e.description ?? "",
            minutes: e.minutes,
            sourceType: e.sourceType,
            status: e.status,
            approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
          }));
        return {
          csv: timeEntriesCsv(rows),
          key: range.key,
          scope: request.query.month ? ("month" as const) : ("week" as const),
          entries: rows.length,
        };
      });
      track(options.analytics, "time_export", session.workspaceId, { scope, entries });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="meri-tiempo-${key}.csv"`)
        .header("cache-control", "no-store")
        .send(csv);
    },
  );

  done();
}
