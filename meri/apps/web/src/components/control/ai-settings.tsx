"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation } from "@/lib/hooks/use-api";

/** Auto-confirmation flag (D-034) and briefing reminders (D-043); the AI budget lives in «Créditos de IA». */
export function AiSettings({
  gmailAutoconfirm,
  briefingBeforeMeetings,
}: {
  gmailAutoconfirm: boolean;
  briefingBeforeMeetings: boolean;
}) {
  const t = useTranslations("control.ai");
  const { toast } = useToast();
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
    </div>
  );
}
