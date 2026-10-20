/**
 * The single AI budget gate (D-061, [H3], [L13]): access (D-058), credits of the month, Pro's briefing allowance and
 * the USD cost cap (live only, D-062). Every AI call site asks first and falls back to its rules/template path when
 * denied; usage is charged after the call, once per operation unit, with credit notices once per period ([M6]).
 * The check runs before the call and the charge after it: concurrent jobs may overspend slightly (soft limit, [L17]).
 */
import {
  CREDIT_COSTS,
  PLANS,
  creditBalance,
  crossedThresholds,
  localDateKey,
  roundCredits,
  chargeDecision,
  type AiOperation,
  type CreditBalance,
} from "@meri/core";
import {
  countAiOperations,
  creditsGranted,
  creditsUsed,
  getAccess,
  getEntitlements,
  getPreferences,
  getSubscription,
  insertNotification,
  monthlyAiCostMicroUsd,
  notificationExistsForRef,
  periodOf,
  recordAiUsage,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";

export type BudgetDenyReason = "access_inactive" | "credits_exhausted" | "briefing_allowance" | "cost_cap";

export interface BudgetDecision {
  allow: boolean;
  reason: BudgetDenyReason | null;
  /** Credits this operation would charge. */
  cost: number;
  balance: CreditBalance;
}

export interface BudgetOptions {
  now: Date;
  aiMode: "fake" | "live";
  costCapUsd: number;
  /** Operation units (threads, drafts…); the cost is charged per unit, never per model call. */
  units?: number;
}

async function balanceOf(tx: WorkspaceTx, workspaceId: WorkspaceId, period: string): Promise<CreditBalance> {
  const [ent, granted, used] = await Promise.all([
    getEntitlements(tx, workspaceId),
    creditsGranted(tx, workspaceId, period),
    creditsUsed(tx, workspaceId, period),
  ]);
  return creditBalance({ monthly: ent.aiCreditsMonthly, granted, used });
}

/** May this AI operation run now? Never throws for budget reasons: the caller takes its rules path when denied. */
export async function aiBudget(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  operation: AiOperation,
  options: BudgetOptions,
): Promise<BudgetDecision> {
  const period = periodOf(options.now);
  const balance = await balanceOf(tx, workspaceId, period);
  const deny = (reason: BudgetDenyReason, cost: number): BudgetDecision => ({
    allow: false,
    reason,
    cost,
    balance,
  });
  const decision = chargeDecision(balance, operation, options.units ?? 1);
  const access = await getAccess(tx, workspaceId, options.now);
  if (!access.active) return deny("access_inactive", decision.cost);
  if (decision.kind === "deny") return deny("credits_exhausted", decision.cost);
  if (operation === "brief_client") {
    const ent = await getEntitlements(tx, workspaceId);
    const plan = (await getSubscription(tx, workspaceId))?.plan ?? "trial";
    const allowance = ent.features.includes("briefings_unlimited") ? null : PLANS[plan].briefingsMonthly;
    if (allowance !== null && (await countAiOperations(tx, workspaceId, "brief_client", period)) >= allowance)
      return deny("briefing_allowance", decision.cost);
  }
  // The simulated cost is 0, so the USD cap only means something against the live provider.
  if (options.aiMode === "live") {
    const spent = await monthlyAiCostMicroUsd(tx, workspaceId, period);
    if (spent >= options.costCapUsd * 1_000_000) return deny("cost_cap", decision.cost);
  }
  return { allow: true, reason: null, cost: decision.cost, balance };
}

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
}

/**
 * Records the model calls of one operation: the first carries the catalogue credits × units, the rest 0 ([H3]).
 * No calls (rules path) → nothing charged. Crossing 80 % / 100 % of the allowance leaves one notice per period.
 */
export async function chargeAiUsage(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  operation: AiOperation,
  usages: readonly UsageRecord[],
  options: { now: Date; units?: number },
): Promise<{ charged: number }> {
  if (usages.length === 0) return { charged: 0 };
  const period = periodOf(options.now);
  const before = await balanceOf(tx, workspaceId, period);
  const charge = roundCredits(CREDIT_COSTS[operation] * Math.max(1, options.units ?? 1));
  let first = true;
  for (const u of usages) {
    await recordAiUsage(tx, workspaceId, { operation, ...u, credits: first ? charge : 0 }, options.now);
    first = false;
  }
  const after = before.used + charge;
  for (const threshold of crossedThresholds(before.allowance, before.used, after))
    await notifyOncePerPeriod(tx, workspaceId, options.now, {
      template: threshold >= 1 ? "credits.exhausted" : "credits.warning",
      title: threshold >= 1 ? "Créditos de IA agotados" : "Créditos de IA al 80 %",
      body:
        threshold >= 1
          ? "La IA queda en pausa hasta el mes que viene; el plan y el calendario siguen funcionando."
          : "Has usado el 80 % de los créditos de IA de este mes.",
      params: { allowance: before.allowance },
    });
  return { charged: charge };
}

/** Tells the user once per period and reason that the AI is paused (the rules keep working). */
export async function notifyAiPaused(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  reason: BudgetDenyReason,
  now: Date,
  params: Record<string, string | number> = {},
): Promise<void> {
  // Exhausted credits already got their own notice from chargeAiUsage.
  if (reason === "credits_exhausted") return;
  await notifyOncePerPeriod(tx, workspaceId, now, {
    template: `ai.paused.${reason}`,
    title: "IA en pausa",
    body: "Las sugerencias usan reglas por ahora; el plan y el calendario siguen funcionando.",
    params,
  });
}

async function notifyOncePerPeriod(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  now: Date,
  notice: { template: string; title: string; body: string; params: Record<string, string | number> },
): Promise<boolean> {
  const ref = { type: "billing_period", id: periodOf(now) };
  if (await notificationExistsForRef(tx, workspaceId, notice.template, ref)) return false;
  const timezone = (await getPreferences(tx, workspaceId))?.timezone ?? "UTC";
  await insertNotification(
    tx,
    workspaceId,
    { kind: "billing", ...notice, refs: [ref], day: localDateKey(now.getTime(), timezone) },
    now,
  );
  return true;
}

export interface AiStatus {
  /** True when no AI operation would run now (the UI shows the "IA en pausa" banner, D-067). */
  paused: boolean;
  reason: Exclude<BudgetDenyReason, "briefing_allowance"> | null;
  balance: CreditBalance;
  period: string;
  costMicroUsd: number;
}

/** Workspace-level AI state for Control and the banner (no operation-specific allowance). */
export async function aiStatus(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  options: Omit<BudgetOptions, "units">,
): Promise<AiStatus> {
  const period = periodOf(options.now);
  const balance = await balanceOf(tx, workspaceId, period);
  const costMicroUsd = await monthlyAiCostMicroUsd(tx, workspaceId, period);
  const access = await getAccess(tx, workspaceId, options.now);
  const reason = !access.active
    ? "access_inactive"
    : balance.remaining <= 0
      ? "credits_exhausted"
      : options.aiMode === "live" && costMicroUsd >= options.costCapUsd * 1_000_000
        ? "cost_cap"
        : null;
  return { paused: reason !== null, reason, balance, period, costMicroUsd };
}
