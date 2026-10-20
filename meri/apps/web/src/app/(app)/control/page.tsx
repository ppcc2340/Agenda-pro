import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AutonomySelector } from "@/components/control/autonomy";
import { PlanPanel } from "@/components/billing/plan-panel";
import { ValueReportPanel } from "@/components/billing/value-report";
import { WeeklyReviewPanel } from "@/components/billing/weekly-review";
import { PrivacyPanel } from "@/components/control/privacy";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { Suspense } from "react";
import { ActivityList } from "@/components/control/activity-list";
import { AiSettings } from "@/components/control/ai-settings";
import { VerticalSettings } from "@/components/control/vertical-settings";
import { MailPrivacy } from "@/components/control/mail-privacy";
import { ConnectionsPanel } from "@/components/control/connections";
import { NotificationsPanel } from "@/components/control/notifications-panel";
import { getServerConfig } from "@/server/config";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/section";
import type { Notification } from "@/lib/types";
import { apiFetch } from "@/server/api";

interface Preferences {
  timezone: string;
  workStart: string;
  workEnd: string;
  contingencyPct: number;
  autonomy: "suggest_only" | "auto_low_risk";
  gmailAutoconfirm: boolean;
  briefingBeforeMeetings: boolean;
  retentionDays: number;
  vertical: "legal" | "consulting" | "generic";
}
interface AuditPage {
  items: {
    id: string;
    actor: "user" | "system" | "ai";
    action: string;
    createdAt: string;
    undoneAt: string | null;
    undoOfAuditId: string | null;
  }[];
  nextCursor: string | null;
}

export default async function ControlPage() {
  const t = await getTranslations("control");
  const nav = await getTranslations("nav");
  const [prefs, audit, notifications] = await Promise.all([
    apiFetch<Preferences>("/v1/preferences"),
    apiFetch<AuditPage>("/v1/audit?limit=12"),
    apiFetch<{ items: Notification[] }>("/v1/notifications?limit=20").catch(() => ({ items: [] })),
  ]);
  const { modes, env } = getServerConfig();
  const fakeMode = modes.google === "fake";
  return (
    <>
      <PageHeader title={nav("control")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <Panel title={t("autonomy.title")} desc={t("autonomy.desc")}>
        <AutonomySelector autonomy={prefs.autonomy} />
      </Panel>
      <Panel title={t("preferences.title")} desc={t("preferences.desc")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          <dt className="text-ink2">{t("preferences.timezone")}</dt>
          <dd>{prefs.timezone}</dd>
          <dt className="text-ink2">{t("preferences.hours")}</dt>
          <dd className="num">
            {prefs.workStart}–{prefs.workEnd}
          </dd>
          <dt className="text-ink2">{t("preferences.contingency")}</dt>
          <dd className="num">{prefs.contingencyPct} %</dd>
        </dl>
        <Button asChild size="sm" className="mt-3">
          <Link href="/onboarding">{t("preferences.edit")}</Link>
        </Button>
      </Panel>
      <Panel title={t("vertical.title")} desc={t("vertical.desc")}>
        <VerticalSettings vertical={prefs.vertical} />
      </Panel>
      <Panel title={t("connections.title")} desc={t("connections.desc")}>
        <Suspense fallback={null}>
          <ConnectionsPanel fakeMode={fakeMode} timezone={prefs.timezone} />
        </Suspense>
      </Panel>
      <Panel title={t("ai.title")} desc={t("ai.desc")}>
        <AiSettings
          gmailAutoconfirm={prefs.gmailAutoconfirm}
          briefingBeforeMeetings={prefs.briefingBeforeMeetings}
        />
      </Panel>
      <Panel title={t("plan.title")} desc={t("plan.desc")}>
        <PlanPanel />
      </Panel>
      <Panel title={t("value.title")} desc={t("value.desc")}>
        <ValueReportPanel />
      </Panel>
      <Panel title={t("weekly.title")} desc={t("weekly.desc")}>
        <WeeklyReviewPanel />
      </Panel>
      <Panel title={t("notifications.title")} desc={t("notifications.desc")}>
        <NotificationsPanel initial={notifications.items} />
      </Panel>
      <Panel title={t("activity.title")} desc={t("activity.desc")}>
        <ActivityList items={audit.items} />
      </Panel>
      <Panel title={t("mailPrivacy.title")} desc={t("mailPrivacy.desc")}>
        <Suspense fallback={null}>
          <MailPrivacy retentionDays={prefs.retentionDays} />
        </Suspense>
      </Panel>
      <Panel title={t("privacy.title")} desc={t("privacy.desc")}>
        <PrivacyPanel demoMode={env.DEMO_MODE} />
      </Panel>
    </>
  );
}
