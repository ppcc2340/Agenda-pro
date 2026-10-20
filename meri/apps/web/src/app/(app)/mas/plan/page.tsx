import { getTranslations } from "next-intl/server";
import { PlanPanel } from "@/components/billing/plan-panel";
import { CreditsPanel } from "@/components/control/credits";
import { MasHeader } from "@/components/shell/mas-header";
import { Panel } from "@/components/ui/section";

/** Más → «Plan y créditos» (D-067, mobile). */
export default async function MasPlanPage() {
  const t = await getTranslations("mas");
  const tc = await getTranslations("control");
  return (
    <>
      <MasHeader title={t("plan")} subtitle={t("planDesc")} />
      <Panel title={tc("plan.title")} desc={tc("plan.desc")}>
        <PlanPanel />
      </Panel>
      <Panel title={tc("credits.title")} desc={tc("credits.desc")}>
        <CreditsPanel />
      </Panel>
    </>
  );
}
