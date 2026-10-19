"use client";

import { useTranslations } from "next-intl";
import { Pill } from "@/components/ui/pill";
import { useAiUsage } from "@/lib/hooks/use-api";

/** «Créditos de IA» (demo): the plan's monthly credits, spent in proportion to the USD budget of docs/05 §5. */
export function CreditsPanel({ capCredits }: { capCredits: number }) {
  const t = useTranslations("control.credits");
  const tAi = useTranslations("control.ai");
  const usage = useAiUsage();
  const usedUsd = usage.data?.usedUsd ?? 0;
  const capUsd = usage.data?.capUsd ?? 0;
  const pct = capUsd > 0 ? Math.min(100, (usedUsd / capUsd) * 100) : 0;
  const usedCredits = Math.round((pct / 100) * capCredits);
  return (
    <div>
      <div className="num">
        <b className="font-head text-[28px] font-semibold leading-tight">{usedCredits}</b>{" "}
        <span className="text-ink2">{t("used", { cap: capCredits })}</span>
        {usage.data?.paused ? (
          <Pill variant="risk" className="ml-2">
            {tAi("paused")}
          </Pill>
        ) : null}
      </div>
      <div className="my-2 h-2 max-w-[360px] overflow-hidden rounded-full bg-rule">
        <b className="block h-full bg-sea" style={{ width: `${String(Math.round(pct))}%` }} />
      </div>
      <p className="max-w-[60ch] text-ink2">{t("pause")}</p>
      <p className="mt-1 text-[12.5px] text-ink3">
        {tAi("usedAmount", { used: usedUsd.toFixed(2) })} {tAi("used", { cap: capUsd.toFixed(2) })}
        {usage.data?.mode === "fake" ? ` · ${tAi("fakeNote")}` : ""}
      </p>
    </div>
  );
}
