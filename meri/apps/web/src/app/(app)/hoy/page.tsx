import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { Section } from "@/components/ui/section";
import type { Task } from "@/lib/types";
import { apiFetch } from "@/server/api";

export default async function HoyPage() {
  const t = await getTranslations("hoy");
  const tTasks = await getTranslations("tasks");
  const format = await getFormatter();
  const locale = await getLocale();
  const [tasks, prefs] = await Promise.all([
    apiFetch<{ items: Task[] }>("/v1/tasks?limit=50"),
    apiFetch<{ timezone: string }>("/v1/preferences"),
  ]);
  const unscheduled = tasks.items.filter((x) => x.status === "pending" || x.status === "at_risk");
  const title = format.dateTime(new Date(), {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: prefs.timezone,
  });
  return (
    <>
      <PageHeader
        title={title.charAt(0).toLocaleUpperCase(locale) + title.slice(1)}
        subtitle={t("subtitleEmpty")}
        action={<CaptureButton />}
      />
      <Section title={t("dayLine")} className="mt-0">
        <div className="rounded-[10px] border border-rule p-4 text-[13px] text-ink2">
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
          {unscheduled.length > 0 ? (
            <Section title={t("unscheduled")}>
              <ul className="divide-y divide-rule border-t border-rule">
                {unscheduled.map((task) => (
                  <li key={task.id} className="py-3">
                    <div className="font-semibold">{task.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
                      {task.dueAt ? (
                        <span className="num">
                          {tTasks("due", {
                            date: format.dateTime(new Date(task.dueAt), {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                              timeZone: prefs.timezone,
                            }),
                          })}
                        </span>
                      ) : null}
                      {task.estimateMinutes ? (
                        <span className="num">{tTasks("minutes", { n: task.estimateMinutes })}</span>
                      ) : null}
                      <Pill variant="sug">{t("willSchedule")}</Pill>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
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
