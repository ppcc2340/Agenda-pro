import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { Suspense } from "react";
import { ActivityList } from "@/components/control/activity-list";
import { AiSettings } from "@/components/control/ai-settings";
import { MailPrivacy } from "@/components/control/mail-privacy";
import { ConnectionsPanel } from "@/components/control/connections";
import { NotificationsPanel } from "@/components/control/notifications-panel";
import { getServerConfig } from "@/server/config";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Panel } from "@/components/ui/section";
import type { Notification } from "@/lib/types";
import { apiFetch, getMe } from "@/server/api";

interface Preferences {
  timezone: string;
  workStart: string;
  workEnd: string;
  contingencyPct: number;
  autonomy: "suggest_only" | "auto_low_risk";
  gmailAutoconfirm: boolean;
  briefingBeforeMeetings: boolean;
  retentionDays: number;
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
  const format = await getFormatter();
  const [me, prefs, audit, notifications] = await Promise.all([
    getMe(),
    apiFetch<Preferences>("/v1/preferences"),
    apiFetch<AuditPage>("/v1/audit?limit=12"),
    apiFetch<{ items: Notification[] }>("/v1/notifications?limit=20").catch(() => ({ items: [] })),
  ]);
  const fakeMode = getServerConfig().modes.google === "fake";
  const KNOWN_STATUS = ["trialing", "active", "past_due", "canceled", "unpaid"] as const;
  type PlanStatus = (typeof KNOWN_STATUS)[number];
  const rawStatus = me?.plan.status ?? "trialing";
  const planStatus: PlanStatus = (KNOWN_STATUS as readonly string[]).includes(rawStatus)
    ? (rawStatus as PlanStatus)
    : "trialing";
  const autonomy = prefs.autonomy === "auto_low_risk" ? "low" : "suggest";
  return (
    <>
      <PageHeader title={nav("control")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <Panel title={t("autonomy.title")} desc={t("autonomy.desc")}>
        <Pill variant="sea">{autonomy === "suggest" ? t("autonomy.suggest") : t("autonomy.low")}</Pill>
        <p className="mt-2.5 max-w-[60ch] text-ink2">
          {autonomy === "suggest" ? t("autonomy.suggestBody") : t("autonomy.lowBody")}
        </p>
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
      <Panel title={t("connections.title")} desc={t("connections.desc")}>
        <Suspense fallback={null}>
          <ConnectionsPanel fakeMode={fakeMode} timezone={prefs.timezone} />
        </Suspense>
      </Panel>
      <Panel title={t("ai.title")} desc={t("ai.desc")}>
        <AiSettings
          gmailAutoconfirm={prefs.gmailAutoconfirm}
          briefingBeforeMeetings={prefs.briefingBeforeMeetings}
          capCredits={me?.entitlements.aiCreditsMonthly ?? 0}
        />
      </Panel>
      <Panel
        title={t("plan.title")}
        desc={
          me?.plan.plan === "trial" && me.plan.trialEndsAt
            ? t("plan.trial", { date: format.dateTime(new Date(me.plan.trialEndsAt), { dateStyle: "long" }) })
            : t("plan.pro")
        }
      >
        <Pill variant="plain">{t(`plan.status.${planStatus}`)}</Pill>
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
        <div className="flex flex-wrap gap-2">
          <Button disabled title={t("privacy.soon")}>
            {t("privacy.export")}
          </Button>
          <Button variant="risk" disabled title={t("privacy.soon")}>
            {t("privacy.delete")}
          </Button>
        </div>
        <p className="mt-2 text-[12.5px] text-ink3">{t("privacy.soon")}</p>
      </Panel>
    </>
  );
}
