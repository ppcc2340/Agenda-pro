import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../client";
import { newId } from "../ids";
import { TEST_ADMIN_URL, TEST_APP_URL } from "../test/urls";
import { ADMIN_WORKSPACE_CONTEXT } from "../workspace";
import { bootstrapAccount } from "./accounts";
import { loadBetaAggregates } from "./beta-metrics";

const NOW = new Date("2026-10-21T09:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

/** D-100: the panel's aggregates over a controlled pair of workspaces (scope keeps other tests' rows out). */
describe("beta metrics aggregates", () => {
  const app = createDb(TEST_APP_URL, { max: 1 });
  const owner = createDb(TEST_ADMIN_URL, {
    max: 1,
    connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  /** Rows of one workspace, written by the owner inside that workspace's RLS context. */
  const inWs = (ws: string, fn: (tx: typeof owner.sql) => Promise<unknown>) =>
    owner.sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${ws}, true)`;
      await fn(tx as unknown as typeof owner.sql);
    });
  const audit = (
    tx: typeof owner.sql,
    ws: string,
    user: string | null,
    action: string,
    at: string,
    after?: unknown,
  ) =>
    tx`insert into audit_log (id, workspace_id, actor, actor_user_id, action, entity_type, after, created_at)
       values (${newId()}, ${ws}, ${user ? "user" : "system"}, ${user}, ${action}, 'workspace', ${after ? JSON.stringify(after) : null}::jsonb, ${at}::timestamptz)`;

  it("computes retention, conversion by cohort, proposal quality, Gmail kept, Sean Ellis, margin and account health", async () => {
    const a = await bootstrapAccount(app.db, {
      email: `bm-a-${newId()}@test.local`,
      now: new Date(daysAgo(30)),
    });
    const b = await bootstrapAccount(app.db, {
      email: `bm-b-${newId()}@test.local`,
      now: new Date(daysAgo(30)),
    });
    await inWs(a.workspaceId, async (tx) => {
      // Activated 70 days ago and active in the week before day 60 (not in the week before day 30).
      await audit(tx, a.workspaceId, a.userId, "proposal.confirmed", daysAgo(70));
      await audit(tx, a.workspaceId, a.userId, "task.created", daysAgo(15));
      await audit(tx, a.workspaceId, null, "billing.invoice_paid", daysAgo(10));
      await tx`update subscriptions set price_cohort = 'B' where workspace_id = ${a.workspaceId}`;
      for (const status of ["confirmed", "confirmed", "confirmed", "edited"])
        await tx`insert into proposals (id, workspace_id, kind, status, payload) values (${newId()}, ${a.workspaceId}, 'capture', ${status}, '{}')`;
      await audit(tx, a.workspaceId, a.userId, "integration.connected", daysAgo(40), { scopes: [GMAIL] });
      await tx`insert into integration_accounts (id, workspace_id, provider, external_account_id, scopes, encrypted_tokens, key_id, status)
               values (${newId()}, ${a.workspaceId}, 'google', ${`sub-${newId()}`}, ${JSON.stringify([GMAIL])}::jsonb, 'x', 'local', 'healthy')`;
      await tx`insert into survey_responses (id, workspace_id, kind, answer) values (${newId()}, ${a.workspaceId}, 'sean_ellis', 'very')`;
      await tx`insert into billing_rollups (id, workspace_id, period, plan, charged, computed_at, gross_margin_pct) values (${newId()}, ${a.workspaceId}, '2026-09', 'pro', true, now(), 80)`;
    });
    await inWs(b.workspaceId, async (tx) => {
      await audit(tx, b.workspaceId, b.userId, "plan.accepted", daysAgo(65));
      for (const status of ["dismissed", "pending"])
        await tx`insert into proposals (id, workspace_id, kind, status, payload) values (${newId()}, ${b.workspaceId}, 'capture', ${status}, '{}')`;
      await audit(tx, b.workspaceId, b.userId, "integration.connected", daysAgo(35), { scopes: [GMAIL] });
      await audit(tx, b.workspaceId, null, "integration.needs_reauth", daysAgo(20));
      await tx`insert into integration_accounts (id, workspace_id, provider, external_account_id, scopes, encrypted_tokens, key_id, status)
               values (${newId()}, ${b.workspaceId}, 'google', ${`sub-${newId()}`}, ${JSON.stringify([GMAIL])}::jsonb, 'x', 'local', 'needs_reauth')`;
      await tx`insert into survey_responses (id, workspace_id, kind, answer) values (${newId()}, ${b.workspaceId}, 'sean_ellis', 'not')`;
      await tx`insert into billing_rollups (id, workspace_id, period, plan, charged, computed_at, gross_margin_pct) values (${newId()}, ${b.workspaceId}, '2026-09', 'pro', true, now(), 60)`;
    });

    const agg = await loadBetaAggregates(owner.db, NOW, { workspaceIds: [a.workspaceId, b.workspaceId] });
    expect(agg.retention).toEqual({ 30: { hits: 0, n: 2 }, 60: { hits: 1, n: 2 }, 90: { hits: 0, n: 0 } });
    expect(agg.trialToPaid).toEqual({ hits: 1, n: 2 });
    expect(agg.trialToPaidByCohort).toEqual({ A: { hits: 0, n: 1 }, B: { hits: 1, n: 1 } });
    expect(agg.confirmedUnedited).toEqual({ hits: 3, n: 5 });
    expect(agg.gmailKept30).toEqual({ hits: 1, n: 2 });
    expect(agg.seanEllis).toEqual({ very: 1, somewhat: 0, not: 1, na: 0 });
    expect(agg.grossMargin).toEqual({ meanPct: 70, n: 2, period: "2026-09" });
    expect(agg.accounts).toEqual({ degraded: 0, needsReauth: 1 });
    // Only counts come out: no ids or addresses.
    expect(JSON.stringify(agg)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
