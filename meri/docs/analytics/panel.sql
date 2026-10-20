-- Meri internal decision panel (D-065, docs/09 "Umbrales de decisión").
-- Read-only queries over the application database, run with the owner connection and the admin read context:
--   SET app.workspace_id = '*';
-- Metabase (or psql) points here once there is a deployment. Ids and counts only: no content, no names.
-- Each query is separated by a line "-- name: <key>"; scripts/test/panel-sql.test.ts runs every one of them.

-- name: activation
-- % of signups that completed onboarding, and median minutes from signup to onboarding.
select
  count(*) as signups,
  count(p.onboarded_at) as onboarded,
  round(100.0 * count(p.onboarded_at) / nullif(count(*), 0), 1) as onboarded_pct,
  percentile_cont(0.5) within group (order by extract(epoch from (p.onboarded_at - w.created_at)) / 60)
    filter (where p.onboarded_at is not null) as median_minutes_to_onboard
from workspaces w
join preferences p on p.workspace_id = w.id
where w.deleted_at is null;

-- name: aha_moment
-- Workspaces with a first confirmed commitment or a first accepted plan (the "aha" moment, docs/09).
select
  count(*) filter (where exists (
    select 1 from audit_log a where a.workspace_id = w.id and a.action in ('commitment.confirmed', 'commitment.autoconfirmed', 'plan.accepted')
  )) as workspaces_with_aha,
  count(*) as workspaces
from workspaces w
where w.deleted_at is null;

-- name: retention
-- 30/60/90-day retention of activated workspaces: a user action in the 7 days around each mark.
with activated as (
  select w.id, p.onboarded_at as since
  from workspaces w join preferences p on p.workspace_id = w.id
  where w.deleted_at is null and p.onboarded_at is not null
),
marks as (select unnest(array[30, 60, 90]) as days)
select
  m.days,
  count(*) filter (where a.since + make_interval(days => m.days) <= now()) as eligible,
  count(*) filter (where a.since + make_interval(days => m.days) <= now() and exists (
    select 1 from audit_log l
    where l.workspace_id = a.id and l.actor = 'user'
      and l.created_at between a.since + make_interval(days => m.days - 3) and a.since + make_interval(days => m.days + 4)
  )) as retained
from marks m cross join activated a
group by m.days
order by m.days;

-- name: weekly_active
-- WAU / MAU from user actions in the audit trail.
select
  count(distinct workspace_id) filter (where created_at >= now() - interval '7 days') as wau,
  count(distinct workspace_id) filter (where created_at >= now() - interval '30 days') as mau
from audit_log
where actor = 'user';

-- name: proposal_quality
-- AI quality: confirmed without edits, edited, dismissed, per proposal kind (docs/09 "Calidad IA").
select
  kind,
  count(*) filter (where status in ('confirmed', 'edited', 'dismissed')) as resolved,
  round(100.0 * count(*) filter (where status = 'confirmed') / nullif(count(*) filter (where status in ('confirmed', 'edited', 'dismissed')), 0), 1) as confirmed_unedited_pct,
  round(100.0 * count(*) filter (where status = 'edited') / nullif(count(*) filter (where status in ('confirmed', 'edited', 'dismissed')), 0), 1) as edited_pct,
  round(100.0 * count(*) filter (where status = 'dismissed') / nullif(count(*) filter (where status in ('confirmed', 'edited', 'dismissed')), 0), 1) as dismissed_pct
from proposals
group by kind
order by kind;

-- name: trial_conversion
-- Trial → paid: workspaces whose trial ended (or that paid) and how many have a paid invoice.
select
  count(*) filter (where s.trial_ends_at <= now() or exists (
    select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid'
  )) as trials_ended,
  count(*) filter (where exists (
    select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid'
  )) as paid,
  round(100.0 * count(*) filter (where exists (
    select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid'
  )) / nullif(count(*) filter (where s.trial_ends_at <= now() or exists (
    select 1 from audit_log a where a.workspace_id = s.workspace_id and a.action = 'billing.invoice_paid'
  )), 0), 1) as conversion_pct
from subscriptions s
join workspaces w on w.id = s.workspace_id and w.deleted_at is null;

-- name: mrr
-- Estimated MRR from the plan catalogue mirror (yearly plans per month), in USD.
select
  round(sum(r.revenue_micro_usd) / 1e6, 2) as mrr_usd,
  count(*) filter (where r.charged) as paying_workspaces
from billing_rollups r
where r.period = to_char(now(), 'YYYY-MM');

-- name: gross_margin
-- Gross margin per paying workspace this month; the alarm is < 70 % (D-062).
select
  count(*) as paying,
  round(avg(r.gross_margin_pct)::numeric, 1) as avg_margin_pct,
  count(*) filter (where r.margin_alarm) as alarms
from billing_rollups r
where r.period = to_char(now(), 'YYYY-MM') and r.charged;

-- name: gmail_kept_30d
-- Workspaces that connected Gmail at least 30 days ago and still have it healthy.
select
  count(*) as connected_30d_ago,
  count(*) filter (where a.status in ('healthy', 'degraded')) as still_connected,
  round(100.0 * count(*) filter (where a.status in ('healthy', 'degraded')) / nullif(count(*), 0), 1) as kept_pct
from integration_accounts a
where a.scopes ? 'https://www.googleapis.com/auth/gmail.readonly'
  and a.created_at <= now() - interval '30 days';

-- name: cancellation_reasons
-- Cancellation survey reasons (comments stay out of the panel).
select reason, count(*) as cancellations
from cancellation_feedback
group by reason
order by cancellations desc;

-- name: value_delivered
-- Value events this month by type (docs/09 "Valor").
select type, count(*) as events, round(sum(quantity)::numeric, 1) as quantity
from value_events
where created_at >= date_trunc('month', now())
group by type
order by type;
