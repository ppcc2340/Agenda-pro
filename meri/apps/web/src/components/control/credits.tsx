"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Pill } from "@/components/ui/pill";
import { useAiUsage } from "@/lib/hooks/use-api";

/** «Créditos de IA» (demo, D-061): the month's credits (plan + packs) and, underneath, the USD safety cap. */
export function CreditsPanel() {
  const t = useTranslations("control.credits");
  const tAi = useTranslations("control.ai");
  const tApp = useTranslations("app");
  const usage = useAiUsage();
  const format = useFormatter();
  const usd = (n: number) => format.number(n, { style: "currency", currency: "USD" });
  if (usage.isPending) return <p className="text-ink2">{tApp("loading")}</p>;
  if (!usage.data) return <p className="text-ink2">{tApp("errorBody")}</p>;
  const { credits } = usage.data;
  const pct = credits.allowance > 0 ? Math.min(100, Math.round((credits.used / credits.allowance) * 100)) : 0;
  return (
    <div>
      <div className="num">
        <b className="font-head text-[28px] font-semibold leading-tight">{format.number(credits.used)}</b>{" "}
        <span className="text-ink2">{t("used", { cap: format.number(credits.allowance) })}</span>
        {usage.data.paused ? (
          <Pill variant="risk" className="ml-2">
            {tAi("paused")}
          </Pill>
        ) : null}
      </div>
      <div
        className="my-2 h-2 max-w-[360px] overflow-hidden rounded-full bg-rule"
        role="progressbar"
        aria-label={t("title")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <b
          className={pct >= 80 ? "block h-full bg-risk" : "block h-full bg-sea"}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <p className="max-w-[60ch] text-ink2">{t("pause")}</p>
      <p className="mt-1 text-[12.5px] text-ink3">
        {t("spent", { used: usd(usage.data.usedUsd), cap: usd(usage.data.capUsd) })}
        {usage.data.mode === "fake" ? ` · ${tAi("fakeNote")}` : ""}
      </p>
    </div>
  );
}
