import { randomUUID } from "node:crypto";
import type { Logger } from "@meri/config";
import { CalendarSyncJob, DailyReviewJob, dueForDigest, type JobDispatcher } from "@meri/jobs";
import type postgres from "postgres";

export interface DispatcherDeps {
  /** Owner connection: dispatchers enumerate across tenants (D-025), then enqueue tenant-scoped jobs. */
  adminSql: postgres.Sql;
  dispatcher: JobDispatcher;
  logger: Logger;
  now: () => Date;
}

/** Polling fallback (docs/07): every healthy Google account not synced in the last 5 minutes gets a calendar.sync job. */
export async function dispatchCalendarPolling(deps: DispatcherDeps, staleMinutes = 5): Promise<number> {
  const olderThan = new Date(deps.now().getTime() - staleMinutes * 60_000);
  const rows = await deps.adminSql<{ id: string; workspaceId: string }[]>`
    select id, workspace_id as "workspaceId" from integration_accounts
    where provider = 'google' and status in ('healthy', 'degraded') and (last_sync_at is null or last_sync_at < ${olderThan})
    order by last_sync_at nulls first limit 500`;
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      CalendarSyncJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), integrationAccountId: row.id, reason: "poll" },
      // Bucketed per poll window: a retained completed job must never swallow the next poll (BullMQ ignores
      // `add` for an existing id in any state).
      { jobId: `calendar.sync:${row.id}:poll:${String(Math.floor(Date.now() / (staleMinutes * 60_000)))}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ accounts: rows.length }, "calendar polling dispatched");
  return rows.length;
}

/**
 * Start-of-day digest (D-020): every onboarded workspace whose local clock passed its work start and that has no
 * digest for today gets one `daily.review` job (jobId per workspace and day, so re-runs are harmless).
 */
export async function dispatchDailyReview(deps: DispatcherDeps): Promise<number> {
  const rows = await deps.adminSql<
    { workspaceId: string; timezone: string; workStart: string; lastDigestDay: string | null }[]
  >`
    select p.workspace_id as "workspaceId", p.timezone, p.work_start as "workStart",
      (select max(n.day) from notifications n where n.workspace_id = p.workspace_id and n.kind = 'digest') as "lastDigestDay"
    from preferences p where p.onboarded_at is not null limit 5000`;
  const due = dueForDigest(rows, deps.now());
  for (const d of due) {
    await deps.dispatcher.enqueue(
      DailyReviewJob,
      { workspaceId: d.workspaceId, traceId: randomUUID(), date: d.date },
      { jobId: `daily.review:${d.workspaceId}:${d.date}` },
    );
  }
  if (due.length > 0) deps.logger.info({ workspaces: due.length }, "daily review dispatched");
  return due.length;
}

/** Runs `fn` every `everyMs`, never overlapping, with errors logged (not thrown). Returns a stop function. */
export function schedule(
  name: string,
  everyMs: number,
  fn: () => Promise<unknown>,
  logger: Logger,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    fn()
      .catch((err: unknown) => {
        logger.error({ err, cron: name }, "cron failed");
      })
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
