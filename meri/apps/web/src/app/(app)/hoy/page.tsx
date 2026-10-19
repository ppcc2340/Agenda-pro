import { getTranslations } from "next-intl/server";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Section } from "@/components/ui/section";

export default async function HoyPage() {
  const t = await getTranslations("hoy");
  const nav = await getTranslations("nav");
  return (
    <>
      <PageHeader title={nav("hoy")} subtitle={t("subtitleCalm")} action={<CaptureButton />} />
      <Section title={t("dayLine")} className="mt-0">
        <div className="rounded-[10px] border border-dashed border-rule p-4 text-[12.5px] text-ink3">
          <div className="grid grid-cols-[104px_1fr] items-center gap-2">
            <span className="font-semibold text-ink2">{t("laneCalendar")}</span>
            <div className="h-10 rounded-[10px] bg-panel" />
            <span className="font-semibold text-ink2">{t("lanePlan")}</span>
            <div className="h-10 rounded-[10px] bg-panel" />
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            <span>{t("legendFixed")}</span>
            <span>{t("legendBlock")}</span>
            <span>{t("legendSuggested")}</span>
          </div>
        </div>
      </Section>
      <div className="mt-1.5 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <Section title={t("q1")} className="mt-2">
            <EmptyState title={t("emptyNowTitle")} body={t("emptyNowBody")} />
          </Section>
          <Section title={t("q2")}>
            <p className="py-4 text-ink2">{t("emptyImportant")}</p>
          </Section>
        </div>
        <div>
          <Section title={t("q3")} className="mt-2">
            <EmptyState title={t("emptyRisksTitle")} body={t("emptyRisksBody")} />
          </Section>
          <Section title={t("q4")}>
            <p className="py-4 text-ink2">{t("emptyWaiting")}</p>
          </Section>
        </div>
      </div>
    </>
  );
}
