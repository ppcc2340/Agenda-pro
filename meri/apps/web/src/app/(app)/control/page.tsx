import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { ActivityList } from "@/components/control/activity-list";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Panel } from "@/components/ui/section";
import { apiFetch, getMe } from "@/server/api";

interface Preferences {
  timezone: string;
  workStart: string;
  workEnd: string;
  contingencyPct: number;
  autonomy: "suggest_only" | "auto_low_risk";
}
interface AuditPage {
  items: {
    id: string;
    actor: "user" | "system" | "ai";
    action: string;
    createdAt: string;
    undoneAt: string | null;
  }[];
  nextCursor: string | null;
}

export default async function ControlPage() {
  const t = await getTranslations("control");
  const nav = await getTranslations("nav");
  const format = await getFormatter();
  const locale = await getLocale();
  const [me, prefs, audit] = await Promise.all([
    getMe(),
    apiFetch<Preferences>("/v1/preferences"),
    apiFetch<AuditPage>("/v1/audit?limit=8"),
  ]);
  const creditsUsed = 0; // ai_usage rollup arrives in phase 4
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
        <div
          className="inline-flex overflow-hidden rounded-[10px] border border-rule bg-raised"
          role="group"
          aria-label={t("autonomy.current")}
        >
          <span
            className={
              autonomy === "suggest"
                ? "bg-sea px-3.5 py-1.5 font-semibold text-on-sea"
                : "px-3.5 py-1.5 font-semibold text-ink2"
            }
            aria-current={autonomy === "suggest" ? "true" : undefined}
          >
            {t("autonomy.suggest")}
          </span>
          <span
            className={
              autonomy === "low"
                ? "bg-sea px-3.5 py-1.5 font-semibold text-on-sea"
                : "px-3.5 py-1.5 font-semibold text-ink2"
            }
            aria-current={autonomy === "low" ? "true" : undefined}
          >
            {t("autonomy.low")}
          </span>
        </div>
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
        <div className="flex items-center justify-between gap-3.5 border-b border-dashed border-rule py-2">
          <div>
            <b>{t("connections.calendar")}</b>
            <div className="text-ink2">{t("connections.calendarScope")}</div>
          </div>
          <Pill variant="plain">{t("connections.notConnected")}</Pill>
        </div>
        <div className="flex items-center justify-between gap-3.5 border-b border-dashed border-rule py-2">
          <div>
            <b>{t("connections.gmail")}</b>
            <div className="text-ink2">{t("connections.gmailScope")}</div>
          </div>
          <Pill variant="plain">{t("connections.notConnected")}</Pill>
        </div>
        <div className="flex items-center justify-between gap-3.5 py-2">
          <div>
            <b>{t("connections.others")}</b>
            <div className="text-ink2">{t("connections.othersBody")}</div>
          </div>
          <Pill variant="plain">{t("connections.soon")}</Pill>
        </div>
      </Panel>
      <Panel title={t("credits.title")} desc={t("credits.desc")}>
        <div className="num">
          <b className="font-head text-2xl font-semibold">{creditsUsed}</b>{" "}
          <span className="text-ink2">
            {t("credits.used", { cap: me?.entitlements.aiCreditsMonthly ?? 0 })}
          </span>
        </div>
        <div className="my-2 h-2 max-w-[360px] overflow-hidden rounded-full bg-rule">
          <b className="block h-full w-0 bg-sea" />
        </div>
        <p className="text-ink2">{t("credits.pause")}</p>
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
      <Panel title={t("activity.title")} desc={t("activity.desc")}>
        <ActivityList items={audit.items} locale={locale} />
      </Panel>
      <Panel title={t("privacy.title")} desc={t("privacy.desc")}>
        <div className="flex flex-wrap gap-2">
          <Button disabled title={t("privacy.soon")}>
            {t("privacy.pause")}
          </Button>
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
