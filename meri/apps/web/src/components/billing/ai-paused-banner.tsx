import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { AiUsage } from "@/lib/types";
import { apiFetch } from "@/server/api";

/** D-067: «IA en pausa» whenever the budget gate would deny every AI call; the plan and calendar keep working. */
export async function AiPausedBanner() {
  const usage = await apiFetch<AiUsage>("/v1/ai/usage").catch(() => null);
  if (!usage?.paused || !usage.reason) return null;
  const t = await getTranslations("billing.banner");
  return (
    <div role="status" className="mb-4 rounded-xl border border-risk bg-risk-soft px-4 py-3 text-[13.5px]">
      <b>{t("title")}</b> {t(`reasons.${usage.reason}`)} {t("keepsWorking")}{" "}
      <Link href="/control#plan" className="font-semibold text-risk underline underline-offset-2">
        {t("action")}
      </Link>
    </div>
  );
}
