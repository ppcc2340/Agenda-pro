"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useWeeklyReview } from "@/lib/hooks/use-api";
import { cn } from "@/lib/cn";

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/** D-064: planned load vs capacity per day, estimate vs actual per completed task, trend vs last week. No AI. */
export function WeeklyReviewPanel() {
  const t = useTranslations("review.weekly");
  const format = useFormatter();
  const review = useWeeklyReview();
  if (review.isPending) return <p className="text-ink2">{t("loading")}</p>;
  if (!review.data) return <p className="text-ink2">{t("unavailable")}</p>;
  const w = review.data;
  const dayName = (day: string) =>
    format.dateTime(new Date(`${day}T12:00:00Z`), { weekday: "short", timeZone: "UTC" });
  return (
    <div>
      <ul className="grid grid-cols-7 gap-1.5" aria-label={t("load")}>
        {w.days.map((d) => {
          const pct = d.load === null ? 0 : Math.min(100, Math.round(d.load * 100));
          return (
            <li key={d.day} className="text-center">
              <div
                className="mx-auto flex h-20 w-full max-w-[44px] items-end overflow-hidden rounded-lg bg-rule"
                role="img"
                aria-label={
                  d.load === null
                    ? t("dayOff", { day: dayName(d.day) })
                    : t("dayLoad", {
                        day: dayName(d.day),
                        planned: hours(d.plannedMinutes),
                        capacity: hours(d.capacityMinutes),
                      })
                }
              >
                <b
                  className={cn("block w-full", d.load !== null && d.load > 1 ? "bg-risk" : "bg-sea")}
                  style={{ height: `${String(pct)}%` }}
                />
              </div>
              <span className="mt-1 block text-[12px] text-ink2">{dayName(d.day)}</span>
            </li>
          );
        })}
      </ul>
      <p className="num mt-3 text-ink2">
        {t("totals", {
          planned: hours(w.totals.plannedMinutes),
          capacity: hours(w.totals.capacityMinutes),
          done: hours(w.totals.completedMinutes),
        })}
      </p>
      {w.trend && w.trend.plannedDeltaPct !== null ? (
        <p className="text-[13px] text-ink3">{t("trend", { pct: w.trend.plannedDeltaPct })}</p>
      ) : null}
      <h4 className="mt-4 text-[14px]">{t("estimates")}</h4>
      {w.estimates.length === 0 ? (
        <p className="text-ink2">{t("noEstimates")}</p>
      ) : (
        <table className="mt-1 w-full max-w-[560px] text-[13.5px]">
          <thead>
            <tr className="text-left text-ink3">
              <th className="py-1 font-semibold">{t("task")}</th>
              <th className="py-1 text-right font-semibold">{t("estimated")}</th>
              <th className="py-1 text-right font-semibold">{t("actual")}</th>
            </tr>
          </thead>
          <tbody>
            {w.estimates.map((e) => (
              <tr key={e.taskId} className="border-t border-rule">
                <td className="py-1.5">{e.title}</td>
                <td className="num py-1.5 text-right">{t("minutes", { n: e.estimateMinutes })}</td>
                <td className={cn("num py-1.5 text-right", Math.abs(e.deltaPct) > 30 && "text-risk")}>
                  {t("minutes", { n: e.actualMinutes })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {w.medianEstimateErrorPct !== null ? (
        <p className="mt-2 text-[13px] text-ink3">{t("median", { pct: w.medianEstimateErrorPct })}</p>
      ) : null}
    </div>
  );
}
