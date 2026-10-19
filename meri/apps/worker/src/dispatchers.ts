import { randomUUID } from "node:crypto";
import type { Logger } from "@meri/config";
import {
  BriefingsPrepareJob,
  CalendarSyncJob,
  ClientsScanJob,
  DailyReviewJob,
  DataRetentionJob,
  FollowupsScanJob,
  GmailSyncJob,
  dueForDigest,
  type JobDispatcher,
} from "@meri/jobs";
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
      { jobId: `calendar.sync_${row.id}_poll_${String(Math.floor(Date.now() / (staleMinutes * 60_000)))}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ accounts: rows.length }, "calendar polling dispatched");
  return rows.length;
}

/** Mail polling fallback (ADR 0004 §1): healthy accounts with Gmail scopes not synced in the last 5 minutes. */
export async function dispatchMailPolling(deps: DispatcherDeps, staleMinutes = 5): Promise<number> {
  const olderThan = new Date(deps.now().getTime() - staleMinutes * 60_000);
  const rows = await deps.adminSql<{ id: string; workspaceId: string }[]>`
    select a.id, a.workspace_id as "workspaceId" from integration_accounts a
    where a.provider = 'google' and a.status in ('healthy', 'degraded')
      and a.scopes ? 'https://www.googleapis.com/auth/gmail.readonly'
      and not exists (select 1 from sync_state s where s.integration_account_id = a.id and s.resource = 'gmail.history' and s.updated_at >= ${olderThan})
    order by a.last_sync_at nulls first limit 500`;
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      GmailSyncJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), integrationAccountId: row.id, reason: "poll" },
      { jobId: `gmail.sync_${row.id}_poll_${String(Math.floor(Date.now() / (staleMinutes * 60_000)))}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ accounts: rows.length }, "mail polling dispatched");
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
      { jobId: `daily.review_${d.workspaceId}_${d.date}` },
    );
  }
  if (due.length > 0) deps.logger.info({ workspaces: due.length }, "daily review dispatched");
  return due.length;
}

/**
 * followups.scan (F-08): hourly for every onboarded workspace with a Gmail account or open third-party commitments.
 * jobId per workspace and hour bucket so retries within the hour collapse.
 */
export async function dispatchFollowupsScan(deps: DispatcherDeps, everyMs = 3_600_000): Promise<number> {
  const rows = await deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and (
      exists (select 1 from integration_accounts a where a.workspace_id = p.workspace_id
              and a.scopes ? 'https://www.googleapis.com/auth/gmail.readonly' and a.status in ('healthy', 'degraded'))
      or exists (select 1 from commitments c where c.workspace_id = p.workspace_id
              and c.direction = 'owed_to_me' and c.status in ('confirmed', 'at_risk')))
    limit 5000`;
  const date = deps.now().toISOString().slice(0, 10);
  const bucket = String(Math.floor(Date.now() / everyMs)); // wall clock: DEMO_NOW is frozen
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      FollowupsScanJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), date },
      { jobId: `followups.scan_${row.workspaceId}_${bucket}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "followups scan dispatched");
  return rows.length;
}

/** clients.scan (D-040): once a day per onboarded workspace with contacts (job id keyed by date). */
export async function dispatchClientsScan(deps: DispatcherDeps): Promise<number> {
  const rows = await deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null
      and exists (select 1 from contacts c where c.workspace_id = p.workspace_id and c.client_id is null)
    limit 5000`;
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      ClientsScanJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), date },
      { jobId: `clients.scan_${row.workspaceId}_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "clients scan dispatched");
  return rows.length;
}

/** briefings.prepare (D-043): once a day per workspace with the preference on and a client meeting ahead. */
export async function dispatchBriefingsPrepare(deps: DispatcherDeps): Promise<number> {
  const horizon = new Date(deps.now().getTime() + 2 * 86_400_000);
  const rows = await deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and p.briefing_before_meetings
      and exists (select 1 from calendar_events e where e.workspace_id = p.workspace_id
                  and e.client_id is not null and e.origin = 'external' and e.starts_at between ${deps.now()} and ${horizon})
    limit 5000`;
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      BriefingsPrepareJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), date },
      { jobId: `briefings.prepare_${row.workspaceId}_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "briefings prepare dispatched");
  return rows.length;
}

/** data.retention (D-036): once a day per workspace that has indexed mail. */
export async function dispatchRetention(deps: DispatcherDeps): Promise<number> {
  const rows = await deps.adminSql<{ workspaceId: string }[]>`
    select distinct workspace_id as "workspaceId" from threads_index limit 5000`;
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      DataRetentionJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), date },
      { jobId: `data.retention_${row.workspaceId}_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "retention dispatched");
  return rows.length;
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
