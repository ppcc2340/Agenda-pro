"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation } from "@/lib/hooks/use-api";

/**
 * Auto-confirmation flag (D-034), briefing reminders (D-043) and consent to the AI quality review (D-103, off by
 * default); the AI budget lives in «Créditos de IA».
 */
export function AiSettings({
  gmailAutoconfirm,
  briefingBeforeMeetings,
  evalConsent,
}: {
  gmailAutoconfirm: boolean;
  briefingBeforeMeetings: boolean;
  evalConsent: boolean;
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
  const [evalOn, setEvalOn] = useState(evalConsent);
  useEffect(() => setEvalOn(evalConsent), [evalConsent]);
  const toggleEval = useApiMutation(
    (value: boolean) => clientApi("/v1/preferences", { method: "PUT", json: { evalConsent: value } }),
    [keys.audit],
    {
      onSuccess: (_d, value) => toast(value ? t("evalConsentOn") : t("evalConsentOff")),
      onError: (_e, value) => setEvalOn(!value),
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
      <div>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={evalOn}
            disabled={toggleEval.isPending}
            onChange={(e) => {
              setEvalOn(e.target.checked);
              toggleEval.mutate(e.target.checked);
            }}
          />
          <span>
            <b>{t("evalConsent")}</b>
            <span className="block text-[13.5px] text-ink2">{t("evalConsentBody")}</span>
          </span>
        </label>
      </div>
    </div>
  );
}
