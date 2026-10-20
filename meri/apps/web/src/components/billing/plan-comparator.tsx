"use client";

import { PLANS, type PaidPlan } from "@meri/core";
import { Check } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Segmented } from "@/components/ui/segmented";
import type { BillingInterval } from "@/lib/types";

const PAID: PaidPlan[] = ["pro", "pro_plus"];

/**
 * D-067: the plan comparator straight from the `@meri/core` catalogue (one source for prices and limits). Public on
 * /precios (CTA to sign in) and inside Control (CTA starts the checkout).
 */
export function PlanComparator({
  onChoose,
  ctaHref,
  current,
  busy,
}: {
  onChoose?: (plan: PaidPlan, interval: BillingInterval) => void;
  ctaHref?: string;
  current?: PaidPlan | null;
  busy?: boolean;
}) {
  const t = useTranslations("pricing");
  const format = useFormatter();
  const [interval, setInterval] = useState<BillingInterval>("month");
  const usd = (cents: number) =>
    format.number(cents / 100, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return (
    <div>
      <Segmented
        label={t("interval")}
        value={interval}
        onChange={setInterval}
        options={(["month", "year"] as const).map((i) => ({ value: i, label: t(`intervals.${i}`) }))}
        className="mb-4"
      />
      <ul className="grid gap-3 md:grid-cols-2">
        {PAID.map((code) => {
          const plan = PLANS[code];
          const name = t(`plans.${code}.name`);
          return (
            <li key={code} className="flex flex-col rounded-2xl border border-rule bg-raised p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg">{name}</h3>
                {current === code ? <Pill variant="ok">{t("current")}</Pill> : null}
              </div>
              <p className="mt-1 text-ink2">{t(`plans.${code}.tagline`)}</p>
              <p className="mt-3">
                <b className="num font-head text-[28px] font-semibold">{usd(plan.priceCents[interval])}</b>{" "}
                <span className="text-ink2">{t("perMonth")}</span>
              </p>
              {interval === "year" ? (
                <p className="text-[12.5px] text-ink3">
                  {t("billedYearly", { total: usd(plan.priceCents.year * 12) })}
                </p>
              ) : null}
              <ul className="mt-3 flex-1 space-y-1.5 text-[13.5px]">
                {[
                  t("features.credits", { n: format.number(plan.aiCreditsMonthly) }),
                  t("features.clients", { n: plan.maxClients }),
                  t("features.retention", { n: plan.retentionDays }),
                  plan.briefingsMonthly === null
                    ? t("features.briefingsUnlimited")
                    : t("features.briefings", { n: plan.briefingsMonthly }),
                  ...(plan.features.includes("advanced_exports") ? [t("features.advancedExports")] : []),
                ].map((line) => (
                  <li key={line} className="flex gap-2">
                    <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                {onChoose ? (
                  <Button
                    variant={code === "pro" ? "primary" : "default"}
                    disabled={busy === true || current === code}
                    onClick={() => onChoose(code, interval)}
                    aria-label={t("choose", { plan: name })}
                  >
                    {t("chooseShort")}
                  </Button>
                ) : ctaHref ? (
                  <Button asChild variant={code === "pro" ? "primary" : "default"}>
                    <Link href={ctaHref}>{t("startTrial")}</Link>
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12.5px] text-ink3">
        {t("trialNote", { credits: format.number(PLANS.trial.aiCreditsMonthly) })}
      </p>
    </div>
  );
}
