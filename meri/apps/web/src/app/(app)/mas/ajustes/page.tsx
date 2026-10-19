import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AutonomySelector, type Autonomy } from "@/components/control/autonomy";
import { ConnectionsPanel } from "@/components/control/connections";
import { CreditsPanel } from "@/components/control/credits";
import { PrivacyPanel } from "@/components/control/privacy";
import { MasHeader } from "@/components/shell/mas-header";
import { Panel } from "@/components/ui/section";
import { apiFetch, getMe } from "@/server/api";
import { getServerConfig } from "@/server/config";

export default async function MasAjustesPage() {
  const t = await getTranslations("mas");
  const tc = await getTranslations("control");
  const [me, prefs] = await Promise.all([
    getMe(),
    apiFetch<{ timezone: string; autonomy: Autonomy }>("/v1/preferences"),
  ]);
  const { modes, env } = getServerConfig();
  return (
    <>
      <MasHeader title={t("settings")} subtitle={t("settingsDesc")} />
      <Panel title={tc("autonomy.title")} desc={tc("autonomy.desc")}>
        <AutonomySelector autonomy={prefs.autonomy} />
      </Panel>
      <Panel title={tc("connections.title")} desc={tc("connections.desc")}>
        <Suspense fallback={null}>
          <ConnectionsPanel fakeMode={modes.google === "fake"} timezone={prefs.timezone} />
        </Suspense>
      </Panel>
      <Panel title={tc("credits.title")} desc={tc("credits.desc")}>
        <CreditsPanel capCredits={me?.entitlements.aiCreditsMonthly ?? 0} />
      </Panel>
      <Panel title={tc("privacy.title")} desc={tc("privacy.desc")}>
        <PrivacyPanel demoMode={env.DEMO_MODE} />
      </Panel>
    </>
  );
}
