import { sql } from "drizzle-orm";
import type { Db } from "../client";

/**
 * Aggregates for the beta decision panel (D-100). Run with the owner connection under the admin read context
 * (`app.workspace_id = '*'`), ideally inside a read-only transaction (`pnpm beta:panel`). Only counts leave this
 * module: no ids, addresses or content. Deleted workspaces are left out.
 * Definitions (plan review CR-L): activity = an `audit_log` row written by the user; activated = their first
 * confirmed or edited proposal, or first accepted plan.
 */
export interface Rate {
  hits: number;
  n: number;
}

export interface BetaAggregates {
  retention: Record<30 | 60 | 90, Rate>;
  trialToPaid: Rate;
  trialToPaidByCohort: Record<"A" | "B", Rate>;
  confirmedUnedited: Rate;
  gmailKept30: Rate;
  seanEllis: { very: number; somewhat: number; not: number; na: number };
  grossMargin: { meanPct: number | null; n: number; period: string | null };
  accounts: { degraded: number; needsReauth: number };
}

const num = (v: unknown): number => Number(v ?? 0);

/** Optional restriction to some workspaces (a design-partner group; tests). Empty or absent = everyone. */
export interface MetricsScope {
  workspaceIds?: readonly string[];
}
const scoped = (scope: MetricsScope) =>
  scope.workspaceIds && scope.workspaceIds.length > 0 ? sql`and w.id in ${[...scope.workspaceIds]}` : sql``;
type Row = Record<string, unknown>;
const first = (rows: unknown[]): Row => (rows[0] ?? {}) as Row;

async function retentionAt(db: Db, now: Date, days: 30 | 60 | 90, scope: MetricsScope): Promise<Rate> {
  const rows = await db.execute(sql`
    with act as (
      select a.actor_user_id as user_id, min(a.created_at) as d0
      from audit_log a join workspaces w on w.id = a.workspace_id and w.deleted_at is null ${scoped(scope)}
      where a.actor = 'user' and a.actor_user_id is not null
        and a.action in ('proposal.confirmed', 'proposal.edited', 'plan.accepted')
      group by a.actor_user_id
    )
    select
      count(*) filter (where act.d0 + make_interval(days => ${days}) <= ${now.toISOString()}::timestamptz) as n,
      count(*) filter (
        where act.d0 + make_interval(days => ${days}) <= ${now.toISOString()}::timestamptz
          and exists (
            select 1 from audit_log b
            where b.actor = 'user' and b.actor_user_id = act.user_id
              and b.created_at >= act.d0 + make_interval(days => ${days - 7})
              and b.created_at < act.d0 + make_interval(days => ${days})
          )
      ) as hits
    from act`);
  const r = first(rows);
  return { hits: num(r.hits), n: num(r.n) };
}

export async function loadBetaAggregates(
  adminDb: Db,
  now: Date,
  scope: MetricsScope = {},
): Promise<BetaAggregates> {
  const [r30, r60, r90] = await Promise.all(
    [30, 60, 90].map((d) => retentionAt(adminDb, now, d as 30 | 60 | 90, scope)),
  );

  // Trial → paid: trials that have ended (or already paid), by the cohort they were priced at.
  const conversion = await adminDb.execute(sql`
    select coalesce(s.price_cohort, 'A') as cohort,
      count(*) as n,
      count(*) filter (where exists (
        select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid'
      )) as hits
    from subscriptions s join workspaces w on w.id = s.workspace_id and w.deleted_at is null ${scoped(scope)}
    where s.trial_ends_at is not null and (
      s.trial_ends_at <= ${now.toISOString()}::timestamptz
      or exists (select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid')
    )
    group by 1`);
  const byCohort: Record<"A" | "B", Rate> = { A: { hits: 0, n: 0 }, B: { hits: 0, n: 0 } };
  for (const row of conversion as Row[])
    byCohort[row.cohort === "B" ? "B" : "A"] = { hits: num(row.hits), n: num(row.n) };

  const proposals = first(
    await adminDb.execute(sql`
      select count(*) filter (where p.status = 'confirmed') as hits,
             count(*) filter (where p.status in ('confirmed', 'edited', 'dismissed')) as n
      from proposals p join workspaces w on w.id = p.workspace_id and w.deleted_at is null ${scoped(scope)}`),
  );

  // Gmail kept at 30 days: first Gmail connection at least 30 days ago; kept if a Gmail connection is healthy now,
  // or lost its grant in the last 7 days (Google "Testing" refresh tokens expire weekly: a reconnect is expected).
  const gmail = first(
    await adminDb.execute(sql`
      with first_gmail as (
        select a.workspace_id, min(a.created_at) as at
        from audit_log a join workspaces w on w.id = a.workspace_id and w.deleted_at is null ${scoped(scope)}
        where a.action = 'integration.connected'
          and a.after -> 'scopes' ? 'https://www.googleapis.com/auth/gmail.readonly'
        group by a.workspace_id
      )
      select count(*) as n,
        count(*) filter (where exists (
          select 1 from integration_accounts ia
          where ia.workspace_id = f.workspace_id
            and ia.scopes ? 'https://www.googleapis.com/auth/gmail.readonly'
            and (
              ia.status in ('healthy', 'degraded')
              or (ia.status = 'needs_reauth' and exists (
                select 1 from audit_log r where r.workspace_id = f.workspace_id and r.action = 'integration.needs_reauth'
                  and r.created_at >= ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz
              ))
            )
        )) as hits
      from first_gmail f
      where f.at <= ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`),
  );

  const survey = await adminDb.execute(sql`
    select r.answer, count(*) as n
    from survey_responses r join workspaces w on w.id = r.workspace_id and w.deleted_at is null ${scoped(scope)}
    where r.kind = 'sean_ellis' and r.answer is not null
    group by r.answer`);
  const seanEllis = { very: 0, somewhat: 0, not: 0, na: 0 };
  for (const row of survey as Row[]) {
    const a = row.answer;
    if (a === "very" || a === "somewhat" || a === "not" || a === "na") seanEllis[a] = num(row.n);
  }

  // Gross margin per paying user over the latest period with charged rollups.
  const margin = first(
    await adminDb.execute(sql`
      with charged as (
        select b.* from billing_rollups b
        join workspaces w on w.id = b.workspace_id and w.deleted_at is null ${scoped(scope)}
        where b.charged
      ),
      latest as (select max(period) as period from charged)
      select l.period, avg(c.gross_margin_pct) as mean, count(c.*) as n
      from latest l left join charged c on c.period = l.period
      group by l.period`),
  );

  const accounts = first(
    await adminDb.execute(sql`
      select count(*) filter (where ia.status = 'degraded') as degraded,
             count(*) filter (where ia.status = 'needs_reauth') as needs_reauth
      from integration_accounts ia join workspaces w on w.id = ia.workspace_id and w.deleted_at is null ${scoped(scope)}`),
  );

  return {
    retention: { 30: r30 ?? { hits: 0, n: 0 }, 60: r60 ?? { hits: 0, n: 0 }, 90: r90 ?? { hits: 0, n: 0 } },
    trialToPaid: { hits: byCohort.A.hits + byCohort.B.hits, n: byCohort.A.n + byCohort.B.n },
    trialToPaidByCohort: byCohort,
    confirmedUnedited: { hits: num(proposals.hits), n: num(proposals.n) },
    gmailKept30: { hits: num(gmail.hits), n: num(gmail.n) },
    seanEllis,
    grossMargin: {
      meanPct: margin.mean === null || margin.mean === undefined ? null : Number(margin.mean),
      n: num(margin.n),
      period: typeof margin.period === "string" ? margin.period : null,
    },
    accounts: { degraded: num(accounts.degraded), needsReauth: num(accounts.needs_reauth) },
  };
}
