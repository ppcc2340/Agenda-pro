import { getTranslations } from "next-intl/server";
import { PlanPanel } from "@/components/billing/plan-panel";
import { MasHeader } from "@/components/shell/mas-header";

/** Más → «Plan y créditos» (D-067, mobile): the page title already names the section, so no panel title. */
export default async function MasPlanPage() {
  const t = await getTranslations("mas");
  return (
    <>
      <MasHeader title={t("plan")} subtitle={t("planDesc")} />
      <div id="plan" className="scroll-mt-6">
        <PlanPanel />
      </div>
    </>
  );
}
