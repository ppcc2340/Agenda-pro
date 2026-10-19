"use client";

import { useTranslations } from "next-intl";
import { isReasonCode, reasonParams } from "@/lib/plan";
import type { Reason } from "@/lib/types";

/** Structured planner reasons rendered through i18n ("por qué está aquí", docs/04). */
export function ReasonList({ reasons }: { reasons: Reason[] }) {
  const t = useTranslations("plan.reasons");
  const known = reasons.filter((r) => isReasonCode(r.code));
  if (known.length === 0) return <span>{t("none")}</span>;
  return (
    <span>
      {known.map((r, i) => (
        <span key={`${r.code}-${String(i)}`}>
          {i > 0 ? " " : ""}
          {isReasonCode(r.code) ? t(r.code, reasonParams(r)) : null}
        </span>
      ))}
    </span>
  );
}
