"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useAiUsage, useApiMutation } from "@/lib/hooks/use-api";

/** Auto-confirmation flag (D-034) and AI budget (docs/05 §5) in the control centre. */
export function AiSettings({
  gmailAutoconfirm,
  briefingBeforeMeetings,
  capCredits,
}: {
  gmailAutoconfirm: boolean;
  briefingBeforeMeetings: boolean;
  capCredits: number;
}) {
  const t = useTranslations("control.ai");
  const { toast } = useToast();
  const usage = useAiUsage();
  // Optimistic: the box flips at once and only reverts if the save fails.
  const [on, setOn] = useState(gmailAutoconfirm);
  useEffect(() => setOn(gmailAutoconfirm), [gmailAutoconfirm]);
  const toggle = useApiMutation(
    (value: boolean) => clientApi("/v1/preferences", { method: "PUT", json: { gmailAutoconfirm: value } }),
    [keys.audit],
    {
      onSuccess: (_d, value) => toast(value ? t("autoconfirmOn") : t("autoconfirmOff")),
      onError: (_e, value) => setOn(!value),
    },
  );
  const [briefOn, setBriefOn] = useState(briefingBeforeMeetings);
  useEffect(() => setBriefOn(briefingBeforeMeetings), [briefingBeforeMeetings]);
  const toggleBrief = useApiMutation(
    (value: boolean) => clientApi("/v1/preferences", { method: "PUT", json: { briefingBeforeMeetings: value } }),
    [keys.audit],
    {
      onSuccess: (_d, value) => toast(value ? t("briefingOn") : t("briefingOff")),
      onError: (_e, value) => setBriefOn(!value),
    },
  );
  const used = usage.data?.usedUsd ?? 0;
  const cap = usage.data?.capUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="grid gap-5">
      <div>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={on}
            disabled={toggle.isPending}
            onChange={(e) => {
              setOn(e.target.checked);
              toggle.mutate(e.target.checked);
            }}
          />
          <span>
            <b>{t("autoconfirm")}</b>
            <span className="block text-[13.5px] text-ink2">{t("autoconfirmBody")}</span>
          </span>
        </label>
      </div>
      <div>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={briefOn}
            disabled={toggleBrief.isPending}
            onChange={(e) => {
              setBriefOn(e.target.checked);
              toggleBrief.mutate(e.target.checked);
            }}
          />
          <span>
            <b>{t("briefing")}</b>
            <span className="block text-[13.5px] text-ink2">{t("briefingBody")}</span>
          </span>
        </label>
      </div>
      <div>
        <div className="num">
          <b className="font-head text-2xl font-semibold">{t("usedAmount", { used: used.toFixed(2) })}</b>{" "}
          <span className="text-ink2">{t("used", { cap: cap.toFixed(2) })}</span>
          {usage.data?.paused ? (
            <Pill variant="risk" className="ml-2">
              {t("paused")}
            </Pill>
          ) : null}
        </div>
        <div className="my-2 h-2 max-w-[360px] overflow-hidden rounded-full bg-rule">
          <b className="block h-full bg-sea" style={{ width: `${String(pct)}%` }} />
        </div>
        <p className="text-ink2">{t("pause")}</p>
        <p className="mt-1 text-[12.5px] text-ink2">{t("credits", { credits: capCredits })}</p>
        {usage.data?.mode === "fake" ? <p className="mt-1 text-[12.5px] text-ink2">{t("fakeNote")}</p> : null}
      </div>
    </div>
  );
}
