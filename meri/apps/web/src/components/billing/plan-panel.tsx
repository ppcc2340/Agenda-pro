"use client";

import type { PaidPlan } from "@meri/core";
import { CreditCard, ExternalLink, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { idempotencyKey, keys, useApiMutation, useBillingSubscription } from "@/lib/hooks/use-api";
import type { BillingInterval, BillingSubscription } from "@/lib/types";
import { CancelDialog } from "./cancel-dialog";
import { PlanComparator } from "./plan-comparator";

const writeHeaders = () => ({ "idempotency-key": idempotencyKey() });
const go = (url: string) => {
  window.location.assign(url);
};

/** The `?billing=` flag the checkout and the portal return with, shown once as a toast. */
function useReturnToast() {
  const t = useTranslations("billing.returned");
  const { toast } = useToast();
  useEffect(() => {
    const url = new URL(window.location.href);
    const flag = url.searchParams.get("billing");
    if (!flag) return;
    if (flag === "success" || flag === "credits" || flag === "cancelled" || flag === "portal") toast(t(flag));
    url.searchParams.delete("billing");
    window.history.replaceState(null, "", url.toString());
  }, [t, toast]);
}

function statusPill(sub: BillingSubscription, t: ReturnType<typeof useTranslations>) {
  if (!sub.access.active) return <Pill variant="risk">{t(`access.${sub.access.reason}`)}</Pill>;
  if (sub.cancelAtPeriodEnd) return <Pill variant="sug">{t("access.ending")}</Pill>;
  return <Pill variant={sub.status === "past_due" ? "risk" : "ok"}>{t(`access.${sub.access.reason}`)}</Pill>;
}

/**
 * Control → «Plan» (D-067): state, trial end, credits of the month (warning at 80 %), add a card, change plan, buy
 * credits, manage billing (portal) and cancel with a survey (D-066). Every write carries an Idempotency-Key ([M5]).
 */
export function PlanPanel() {
  const t = useTranslations("billing");
  const format = useFormatter();
  useReturnToast();
  const sub = useBillingSubscription();
  const [choosing, setChoosing] = useState(false);
  const [buying, setBuying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const invalidate = [keys.billing, keys.aiUsage];
  const checkout = useApiMutation(
    (v: { plan: PaidPlan; interval: BillingInterval }) =>
      clientApi<{ url: string }>("/v1/billing/checkout", {
        method: "POST",
        json: v,
        headers: writeHeaders(),
      }),
    [],
    { onSuccess: (r) => go(r.url) },
  );
  const pack = useApiMutation(
    (packCode: "500" | "2000") =>
      clientApi<{ url: string }>("/v1/billing/credit-packs", {
        method: "POST",
        json: { pack: packCode },
        headers: writeHeaders(),
      }),
    [],
    { onSuccess: (r) => go(r.url) },
  );
  const portal = useApiMutation(
    () => clientApi<{ url: string }>("/v1/billing/portal", { method: "POST", headers: writeHeaders() }),
    [],
    { onSuccess: (r) => go(r.url) },
  );
  const reactivate = useApiMutation(
    () =>
      clientApi<{ status: "resumed" | "checkout"; url: string | null }>("/v1/billing/reactivate", {
        method: "POST",
        headers: writeHeaders(),
      }),
    invalidate,
    {
      onSuccess: (r) => {
        if (r.url) go(r.url);
      },
    },
  );

  if (sub.isPending) return <p className="text-ink2">{t("loading")}</p>;
  if (!sub.data) return <p className="text-ink2">{t("unavailable")}</p>;
  const s = sub.data;
  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "long" }) : "");
  const paid = s.plan !== "trial" && s.status !== "canceled";
  const ratio = s.credits.allowance > 0 ? s.credits.used / s.credits.allowance : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const busy = checkout.isPending || pack.isPending || portal.isPending || reactivate.isPending;

  return (
    <div id="plan" className="scroll-mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <b className="font-head text-lg">{t(`plans.${s.plan}`)}</b>
        {statusPill(s, t)}
        {s.mode === "fake" ? <Pill variant="plain">{t("fakeMode")}</Pill> : null}
      </div>
      <p className="mt-1 text-ink2">
        {s.status === "trialing" && s.trialEndsAt
          ? s.hasPaymentMethod
            ? t("trialWithCard", { date: date(s.trialEndsAt) })
            : t("trialEnds", { date: date(s.trialEndsAt), days: s.access.trialDaysLeft ?? 0 })
          : s.cancelAtPeriodEnd && s.currentPeriodEnd
            ? t("endsOn", { date: date(s.currentPeriodEnd) })
            : s.status === "canceled"
              ? t("ended")
              : s.currentPeriodEnd
                ? t("renewsOn", { date: date(s.currentPeriodEnd) })
                : null}
      </p>
      {!s.access.active ? (
        <p className="mt-1 max-w-[60ch] text-[13.5px] text-ink2">{t("inactiveNote")}</p>
      ) : null}

      <div className="mt-4">
        <div className="num">
          <b className="font-head text-[24px] font-semibold leading-tight">{format.number(s.credits.used)}</b>{" "}
          <span className="text-ink2">
            {t("credits.of", { allowance: format.number(s.credits.allowance) })}
          </span>
        </div>
        <div
          className="my-2 h-2 max-w-[360px] overflow-hidden rounded-full bg-rule"
          role="progressbar"
          aria-label={t("credits.label")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <b
            className={pct >= 80 ? "block h-full bg-risk" : "block h-full bg-sea"}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
        {pct >= 80 ? (
          <p className="text-[13.5px] text-risk">{t(pct >= 100 ? "credits.exhausted" : "credits.warning")}</p>
        ) : null}
        <p className="text-[12.5px] text-ink3">{t("credits.monthly")}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {!paid ? (
          <Button variant="primary" disabled={busy} onClick={() => setChoosing(true)}>
            <CreditCard size={14} aria-hidden="true" />
            {s.status === "canceled" ? t("actions.subscribe") : t("actions.addCard")}
          </Button>
        ) : null}
        {paid && s.hasBillingAccount ? (
          <Button disabled={busy} onClick={() => portal.mutate(undefined)}>
            <ExternalLink size={14} aria-hidden="true" />
            {t("actions.manage")}
          </Button>
        ) : null}
        {s.access.active ? (
          <Button disabled={busy} onClick={() => setBuying(true)}>
            <Sparkles size={14} aria-hidden="true" />
            {t("actions.buyCredits")}
          </Button>
        ) : null}
        {paid && s.cancelAtPeriodEnd ? (
          <Button disabled={busy} onClick={() => reactivate.mutate(undefined)}>
            <RotateCcw size={14} aria-hidden="true" />
            {t("actions.reactivate")}
          </Button>
        ) : null}
        {s.status === "canceled" && s.plan !== "trial" ? (
          <Button disabled={busy} onClick={() => reactivate.mutate(undefined)}>
            <RotateCcw size={14} aria-hidden="true" />
            {t("actions.reactivate")}
          </Button>
        ) : null}
        {paid && !s.cancelAtPeriodEnd ? (
          <Button variant="quiet" disabled={busy} onClick={() => setCancelling(true)}>
            <XCircle size={14} aria-hidden="true" />
            {t("actions.cancel")}
          </Button>
        ) : null}
      </div>

      <Dialog open={choosing} onOpenChange={setChoosing}>
        {choosing ? (
          <DialogContent title={t("choose.title")} description={t("choose.desc")}>
            <PlanComparator
              busy={checkout.isPending}
              current={paid && s.plan !== "trial" ? s.plan : null}
              onChoose={(plan, interval) => checkout.mutate({ plan, interval })}
            />
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={buying} onOpenChange={setBuying}>
        {buying ? (
          <DialogContent title={t("packs.title")} description={t("packs.desc")}>
            <div className="flex flex-wrap gap-2">
              {(["500", "2000"] as const).map((code) => (
                <Button key={code} disabled={pack.isPending} onClick={() => pack.mutate(code)}>
                  {t("packs.buy", { credits: format.number(Number(code)) })}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-ink3">{t("packs.expiry")}</p>
          </DialogContent>
        ) : null}
      </Dialog>
      <CancelDialog open={cancelling} onOpenChange={setCancelling} periodEnd={date(s.currentPeriodEnd)} />
    </div>
  );
}
