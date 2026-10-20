"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation } from "@/lib/hooks/use-api";

export type Autonomy = "suggest_only" | "auto_low_risk";

/** Autonomy selector (demo «Solo sugerir» / «Actuar en lo de bajo riesgo»): `PUT /v1/preferences { autonomy }`. */
export function AutonomySelector({ autonomy }: { autonomy: Autonomy }) {
  const t = useTranslations("control.autonomy");
  const tApp = useTranslations("app");
  const { toast } = useToast();
  const [value, setValue] = useState<Autonomy>(autonomy);
  const save = useApiMutation(
    (next: Autonomy) => clientApi("/v1/preferences", { method: "PUT", json: { autonomy: next } }),
    [keys.audit],
    {
      onSuccess: (_d, next) => toast(t("changed", { label: next === "auto_low_risk" ? t("low") : t("suggest") })),
      onError: (_e, next) => {
        setValue(next === "auto_low_risk" ? "suggest_only" : "auto_low_risk");
        toast(tApp("errorBody"));
      },
    },
  );
  const choose = (next: Autonomy) => {
    // aria-disabled instead of disabled: keyboard focus stays on the button while saving.
    if (next === value || save.isPending) return;
    setValue(next);
    save.mutate(next);
  };
  const option = (key: Autonomy, label: string, short: string) => (
    <button
      type="button"
      aria-pressed={value === key}
      aria-disabled={save.isPending}
      onClick={() => choose(key)}
      className="rounded-full border border-rule bg-raised px-3 py-1.5 text-[13.5px] font-semibold text-ink2 aria-pressed:border-sea aria-pressed:bg-sea-soft aria-pressed:text-ink"
    >
      <span className="md:hidden">{short}</span>
      <span className="hidden md:inline">{label}</span>
    </button>
  );
  return (
    <div>
      <div role="group" aria-label={t("title")} className="flex flex-wrap gap-2">
        {option("suggest_only", t("suggest"), t("suggest"))}
        {option("auto_low_risk", t("low"), t("lowShort"))}
      </div>
      <p className="mt-2.5 max-w-[60ch] text-ink2">{value === "auto_low_risk" ? t("lowBody") : t("suggestBody")}</p>
    </div>
  );
}
