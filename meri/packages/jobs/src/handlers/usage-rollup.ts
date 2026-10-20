/**
 * billing.usage_rollup (D-062, [M10], [L12]): consolidates a workspace's month into `billing_rollups` — credits,
 * real AI cost, revenue estimated from the catalogue (yearly plans spread per month), estimated infrastructure and
 * payment fees, gross margin and the < 70 % alarm (paying users only). Also leaves the `trial.ending` notice once,
 * 3 days before a trial without a card ends.
 */
import { PLANS, grossMargin, periodRevenueMicroUsd } from "@meri/core";
import { getSubscription, periodAiTotals, upsertRollup, withWorkspace, type WorkspaceId } from "@meri/db";
import { notifyBillingOnce } from "../budget";
import type { HandlerDeps } from "./context";

const DAY_MS = 86_400_000;
export const TRIAL_ENDING_NOTICE_DAYS = 3;

export interface UsageRollupResult {
  period: string;
  grossMarginPct: number | null;
  marginAlarm: boolean;
  trialEndingNotified: boolean;
}

export async function runUsageRollup(
  deps: HandlerDeps & { infraCostUsdPerUser: number },
  workspaceId: WorkspaceId,
  period: string,
): Promise<UsageRollupResult> {
  const now = deps.now();
  const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const sub = await getSubscription(tx, workspaceId);
    const plan = sub?.plan ?? "trial";
    // Revenue only while the plan is billed (a trial or an ended subscription brings nothing in).
    const paying = sub !== null && plan !== "trial" && (sub.status === "active" || sub.status === "past_due");
    const priceCents = paying ? PLANS[plan].priceCents[sub.priceInterval ?? "month"] : 0;
    const ai = await periodAiTotals(tx, workspaceId, period);
    const margin = grossMargin({
      revenueMicroUsd: periodRevenueMicroUsd(priceCents),
      aiCostMicroUsd: ai.costMicroUsd,
      infraCostMicroUsd: Math.round(deps.infraCostUsdPerUser * 1_000_000),
      charged: paying,
    });
    await upsertRollup(
      tx,
      workspaceId,
      {
        period,
        plan,
        charged: paying,
        creditsUsed: ai.credits,
        aiCostMicroUsd: ai.costMicroUsd,
        revenueMicroUsd: margin.revenueMicroUsd,
        infraCostMicroUsd: Math.round(deps.infraCostUsdPerUser * 1_000_000),
        paymentFeeMicroUsd: margin.stripeFeeMicroUsd,
        grossMarginPct: margin.grossMarginPct,
        marginAlarm: margin.alarm,
      },
      now,
    );

    let trialEndingNotified = false;
    const left = sub?.trialEndsAt ? sub.trialEndsAt.getTime() - now.getTime() : null;
    if (
      sub?.status === "trialing" &&
      !sub.hasPaymentMethod &&
      left !== null &&
      left > 0 &&
      left <= TRIAL_ENDING_NOTICE_DAYS * DAY_MS
    )
      trialEndingNotified = await notifyBillingOnce(
        tx,
        workspaceId,
        now,
        {
          template: "trial.ending",
          title: "Tu prueba termina pronto",
          body: "Añade una tarjeta en Control → Plan para seguir con la IA. El plan y el calendario siguen funcionando.",
          params: { days: Math.ceil(left / DAY_MS) },
        },
        { type: "trial", id: workspaceId },
      );
    return { grossMarginPct: margin.grossMarginPct, marginAlarm: margin.alarm, trialEndingNotified };
  });
  // Structured, without personal data: ids and figures only.
  if (result.marginAlarm)
    deps.logger.warn(
      { workspaceId, period, grossMarginPct: result.grossMarginPct },
      "gross margin below 70 %",
    );
  return { period, ...result };
}
