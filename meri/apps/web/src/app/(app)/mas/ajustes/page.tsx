import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { signOutAction } from "@/app/actions";
import { AiSettings } from "@/components/control/ai-settings";
import { AutonomySelector, type Autonomy } from "@/components/control/autonomy";
import { MailPrivacy } from "@/components/control/mail-privacy";
import { LocaleSwitch } from "@/components/shell/locale-switch";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { ConnectionsPanel } from "@/components/control/connections";
import { PrivacyPanel } from "@/components/control/privacy";
import { MasHeader } from "@/components/shell/mas-header";
import { Panel } from "@/components/ui/section";
import { apiFetch } from "@/server/api";
import { getServerConfig } from "@/server/config";

export default async function MasAjustesPage() {
  const t = await getTranslations("mas");
  const tc = await getTranslations("control");
  const tApp = await getTranslations("app");
  const [prefs] = await Promise.all([
    apiFetch<{
      timezone: string;
      autonomy: Autonomy;
      gmailAutoconfirm: boolean;
      briefingBeforeMeetings: boolean;
      retentionDays: number;
    }>("/v1/preferences"),
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
      <Panel title={tc("ai.title")} desc={tc("ai.desc")}>
        <AiSettings
          gmailAutoconfirm={prefs.gmailAutoconfirm}
          briefingBeforeMeetings={prefs.briefingBeforeMeetings}
        />
      </Panel>
      <Panel title={tc("mailPrivacy.title")} desc={tc("mailPrivacy.desc")}>
        <Suspense fallback={null}>
          <MailPrivacy retentionDays={prefs.retentionDays} />
        </Suspense>
      </Panel>
      <Panel title={tc("privacy.title")} desc={tc("privacy.desc")}>
        <PrivacyPanel demoMode={env.DEMO_MODE} />
      </Panel>
      {/* On mobile there is no rail: theme, language and sign-out live here (criterion 10, es/en in both formats). */}
      <Panel title={t("account")} desc={t("accountDesc")}>
        <div className="flex flex-wrap items-center gap-4">
          <ThemeToggle className="flex items-center gap-2" />
          <LocaleSwitch />
          <form action={signOutAction}>
            <button type="submit" className="font-semibold text-sea underline-offset-2 hover:underline">
              {tApp("signOut")}
            </button>
          </form>
        </div>
        {env.DEMO_MODE ? <p className="mt-3 text-[12.5px] text-ink3">{tApp("demoNote")}</p> : null}
      </Panel>
    </>
  );
}
