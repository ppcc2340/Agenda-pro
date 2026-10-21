import { randomUUID } from "node:crypto";
import type { Logger } from "@meri/config";
import { PURGE_AFTER_DAYS } from "@meri/db";
import { CALENDAR_SCOPES } from "@meri/integrations";
import {
  BillingUsageRollupJob,
  BriefingsPrepareJob,
  DailyCloseJob,
  CalendarSyncJob,
  ClientsScanJob,
  DailyReviewJob,
  DataRetentionJob,
  DataDeleteAccountJob,
  FollowupsScanJob,
  GmailSyncJob,
  TimeInferJob,
  dueForClose,
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
  /** Accounts per polling run (default 500: bounds the burst of sync jobs each cycle). */
  pollBatch?: number;
}

const POLL_BATCH = 500;

/**
 * D-054: a logically deleted workspace (`DELETE /v1/account`) is never dispatched again; its data waits for the
 * purge job. `alias` names the workspace-scoped table the query reads.
 */
export function activeWorkspace(sql: postgres.Sql, alias = "p"): postgres.PendingQuery<postgres.Row[]> {
  return sql`exists (select 1 from workspaces w where w.id = ${sql(alias)}.workspace_id and w.deleted_at is null)`;
}

/** Page size of the workspace scans. */
export const PAGE = 1000;
const FIRST_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Keyset pagination over workspace ids: every eligible workspace is reached, a page at a time. A fixed `limit`
 * would silently skip the rest once the product has more workspaces than the limit.
 */
export async function eachPage<T extends { workspaceId: string }>(
  page: (after: string) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let after = FIRST_UUID;
  for (;;) {
    const rows = await page(after);
    all.push(...rows);
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) return all;
    // A page query that forgets `> after` or `order by workspace_id` would loop forever: fail loudly instead.
    if (last.workspaceId <= after)
      throw new Error("eachPage: page query must order by workspace_id after the cursor");
    after = last.workspaceId;
  }
}

/** Polling fallback (docs/07): every healthy Google account not synced in the last 5 minutes gets a calendar.sync job. */
export async function dispatchCalendarPolling(deps: DispatcherDeps, staleMinutes = 5): Promise<number> {
  const olderThan = new Date(deps.now().getTime() - staleMinutes * 60_000);
  const rows = await deps.adminSql<{ id: string; workspaceId: string }[]>`
    select p.id, p.workspace_id as "workspaceId" from integration_accounts p
    where p.provider = 'google' and p.status in ('healthy', 'degraded') and ${activeWorkspace(deps.adminSql)}
      -- A Gmail-only connection has no calendar to read: polling it would end in 403 and a needless needs_reauth.
      and p.scopes ? ${CALENDAR_SCOPES[0]}
      and (p.last_sync_at is null or p.last_sync_at < ${olderThan})
    order by p.last_sync_at nulls first limit ${deps.pollBatch ?? POLL_BATCH}`;
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
      and ${activeWorkspace(deps.adminSql, "a")}
      and a.scopes ? 'https://www.googleapis.com/auth/gmail.readonly'
      and not exists (select 1 from sync_state s where s.integration_account_id = a.id and s.resource = 'gmail.history' and s.updated_at >= ${olderThan})
    order by a.last_sync_at nulls first limit ${deps.pollBatch ?? POLL_BATCH}`;
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
  const rows = await eachPage(
    (after) => deps.adminSql<
      { workspaceId: string; timezone: string; workStart: string; lastDigestDay: string | null }[]
    >`
    select p.workspace_id as "workspaceId", p.timezone, p.work_start as "workStart",
      (select max(n.day) from notifications n where n.workspace_id = p.workspace_id and n.kind = 'digest') as "lastDigestDay"
    from preferences p where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)}
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
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

/** End-of-day close (D-064): onboarded workspaces past their work end with no close for today. */
export async function dispatchDailyClose(deps: DispatcherDeps): Promise<number> {
  const rows = await eachPage(
    (after) => deps.adminSql<
      { workspaceId: string; timezone: string; workEnd: string; lastCloseDay: string | null }[]
    >`
    select p.workspace_id as "workspaceId", p.timezone, p.work_end as "workEnd",
      (select max(n.day) from notifications n where n.workspace_id = p.workspace_id and n.template = 'daily.close') as "lastCloseDay"
    from preferences p where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)}
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
  const due = dueForClose(rows, deps.now());
  for (const d of due)
    await deps.dispatcher.enqueue(
      DailyCloseJob,
      { workspaceId: d.workspaceId, traceId: randomUUID(), date: d.date },
      { jobId: `daily.close_${d.workspaceId}_${d.date}` },
    );
  if (due.length > 0) deps.logger.info({ workspaces: due.length }, "daily close dispatched");
  return due.length;
}

/**
 * followups.scan (F-08): hourly for every onboarded workspace with a Gmail account or open third-party commitments.
 * jobId per workspace and hour bucket so retries within the hour collapse.
 */
export async function dispatchFollowupsScan(deps: DispatcherDeps, everyMs = 3_600_000): Promise<number> {
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)} and (
      exists (select 1 from integration_accounts a where a.workspace_id = p.workspace_id
              and a.scopes ? 'https://www.googleapis.com/auth/gmail.readonly' and a.status in ('healthy', 'degraded'))
      or exists (select 1 from commitments c where c.workspace_id = p.workspace_id
              and c.direction = 'owed_to_me' and c.status in ('confirmed', 'at_risk')))
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
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
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)}
      and exists (select 1 from contacts c where c.workspace_id = p.workspace_id and c.client_id is null)
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
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
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)} and p.briefing_before_meetings
      and exists (select 1 from calendar_events e where e.workspace_id = p.workspace_id
                  and e.client_id is not null and e.origin = 'external' and e.starts_at between ${deps.now()} and ${horizon})
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
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

/** time.infer (D-042): once a day per onboarded workspace with a client (job id keyed by date; triggers add more). */
export async function dispatchTimeInfer(deps: DispatcherDeps): Promise<number> {
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select p.workspace_id as "workspaceId" from preferences p
    where p.onboarded_at is not null and ${activeWorkspace(deps.adminSql)}
      and exists (select 1 from clients c where c.workspace_id = p.workspace_id and c.deleted_at is null)
      and p.workspace_id > ${after} order by p.workspace_id limit ${PAGE}`,
  );
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      TimeInferJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), reason: "daily" },
      { jobId: `time.infer_${row.workspaceId}_daily_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "time inference dispatched");
  return rows.length;
}

/** data.retention (D-036, ADR 0007): once a day per workspace with indexed mail or resolved proposals. */
export async function dispatchRetention(deps: DispatcherDeps): Promise<number> {
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select u.workspace_id as "workspaceId" from (
      select workspace_id from threads_index
      union
      select workspace_id from proposals where status in ('dismissed', 'expired')
    ) u
    where u.workspace_id > ${after} order by u.workspace_id limit ${PAGE}`,
  );
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      DataRetentionJob,
      { workspaceId: row.workspaceId, traceId: randomUUID(), date },
      { jobId: `data.retention_${row.workspaceId}_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "retention dispatched");
  // The waitlist has no workspace: its 180-day retention (D-099, SEC-M4) runs here, once per dispatch.
  const [pruned] = await deps.adminSql<{ n: number }[]>`select prune_waitlist() as n`;
  if (pruned && pruned.n > 0) deps.logger.info({ removed: pruned.n }, "waitlist retention applied");
  return rows.length;
}

/** data.delete_account (F-16, ADR 0007): once a day per workspace logically deleted more than 30 days ago. */
export async function dispatchAccountPurge(deps: DispatcherDeps): Promise<number> {
  // Same window as purge_workspace() and the handler (one constant, so they cannot drift).
  const cutoff = new Date(deps.now().getTime() - PURGE_AFTER_DAYS * 86_400_000);
  const rows = await deps.adminSql<{ workspaceId: string }[]>`
    select id as "workspaceId" from workspaces
    where deleted_at is not null and deleted_at < ${cutoff}
    order by deleted_at limit 500`;
  const date = deps.now().toISOString().slice(0, 10);
  for (const row of rows) {
    await deps.dispatcher.enqueue(
      DataDeleteAccountJob,
      { workspaceId: row.workspaceId, traceId: randomUUID() },
      { jobId: `data.delete_account_${row.workspaceId}_${date}` },
    );
  }
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length }, "account purges dispatched");
  return rows.length;
}

/**
 * billing.usage_rollup (D-062): once a day per live workspace for the current month, plus the previous month during
 * the first two days so the closing figures include the last day (job ids keyed by period and date).
 */
export async function dispatchUsageRollup(deps: DispatcherDeps): Promise<number> {
  const rows = await eachPage(
    (after) => deps.adminSql<{ workspaceId: string }[]>`
    select s.workspace_id as "workspaceId" from subscriptions s where ${activeWorkspace(deps.adminSql, "s")}
      and s.workspace_id > ${after} order by s.workspace_id limit ${PAGE}`,
  );
  const now = deps.now();
  const date = now.toISOString().slice(0, 10);
  const periods = [date.slice(0, 7)];
  if (now.getUTCDate() <= 2)
    periods.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7),
    );
  for (const row of rows)
    for (const period of periods)
      await deps.dispatcher.enqueue(
        BillingUsageRollupJob,
        { workspaceId: row.workspaceId, traceId: randomUUID(), period },
        { jobId: `billing.usage_rollup_${row.workspaceId}_${period}_${date}` },
      );
  if (rows.length > 0) deps.logger.info({ workspaces: rows.length, periods }, "usage rollup dispatched");
  return rows.length * periods.length;
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
