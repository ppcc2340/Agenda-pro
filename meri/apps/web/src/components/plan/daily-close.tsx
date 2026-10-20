"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useDailyReview } from "@/lib/hooks/use-api";
import type { ReviewItem } from "@/lib/types";

/** Minutes before the end of the work day from which the close shows on Hoy (D-064). */
const SHOW_BEFORE_END_MIN = 60;

/** Local minutes of the day in `timeZone` for `now`. */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function Group({ title, items }: { title: string; items: ReviewItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[13px] font-semibold text-ink2">{title}</h4>
      <ul className="mt-1 space-y-0.5">
        {items.map((i) => (
          <li key={i.taskId}>{i.title}</li>
        ))}
      </ul>
    </div>
  );
}

/** «Cierre del día» card on Hoy, from the last hour of the work day: what got done and tomorrow's priorities. */
export function DailyClose({
  timezone,
  workEnd,
  now: fixedNow,
}: {
  timezone: string;
  workEnd: string;
  now?: string;
}) {
  const t = useTranslations("review.daily");
  const format = useFormatter();
  // DEMO_NOW freezes the clock (the demo is always at the same moment); otherwise the browser's clock.
  const now = fixedNow ? new Date(fixedNow) : new Date();
  const [h = "18", m = "0"] = workEnd.split(":");
  const show = localMinutes(now, timezone) >= Number(h) * 60 + Number(m) - SHOW_BEFORE_END_MIN;
  const review = useDailyReview(show);
  if (!show || !review.data) return null;
  const d = review.data;
  return (
    <section aria-labelledby="daily-close" className="mt-6 rounded-2xl border border-rule bg-raised p-4">
      <h2 id="daily-close" className="text-lg">
        {t("title")}
      </h2>
      <p className="text-ink2">
        {t("summary", { done: d.done.length, reschedule: d.toReschedule.length, pending: d.pending.length })}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Group title={t("done")} items={d.done} />
        <Group title={t("toReschedule")} items={d.toReschedule} />
        <Group title={t("blocked")} items={d.blocked} />
        <Group title={t("newRisks")} items={d.newRisks} />
      </div>
      {d.tomorrow.length > 0 ? (
        <div className="mt-3">
          <h4 className="text-[13px] font-semibold text-ink2">{t("tomorrow")}</h4>
          <ol className="mt-1 space-y-0.5">
            {d.tomorrow.map((i) => (
              <li key={i.taskId} className="flex gap-2">
                <span className="num text-ink3">
                  {format.dateTime(new Date(i.startsAt), {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: timezone,
                  })}
                </span>
                <span>{i.title}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
