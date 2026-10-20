import { getTranslations } from "next-intl/server";
import { ValueReportPanel } from "@/components/billing/value-report";
import { WeeklyReviewPanel } from "@/components/billing/weekly-review";
import { MasHeader } from "@/components/shell/mas-header";
import { Panel } from "@/components/ui/section";

/** Más → «Valor y revisión» (F-12, mobile). */
export default async function MasValorPage() {
  const t = await getTranslations("mas");
  const tc = await getTranslations("control");
  return (
    <>
      <MasHeader title={t("value")} subtitle={t("valueDesc")} />
      <Panel title={tc("value.title")} desc={tc("value.desc")}>
        <ValueReportPanel />
      </Panel>
      <Panel title={tc("weekly.title")} desc={tc("weekly.desc")}>
        <WeeklyReviewPanel />
      </Panel>
    </>
  );
}
