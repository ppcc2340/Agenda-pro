"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { useCalendarEvents, usePlan } from "@/lib/hooks/use-api";
import { addDays, clientColorVar, dayItems, dayKey, minuteOfDay, weekDays, type DayItem } from "@/lib/plan";
import type { Task } from "@/lib/types";

export interface CalendarViewProps {
  timezone: string;
  workStart: string;
  workEnd: string;
  clients: { id: string; name: string }[];
  now?: string;
}

const hhmm = (s: string) => {
  const [h = "0", m = "0"] = s.split(":");
  return Number(h) * 60 + Number(m);
};
const HOUR_PX = 48;

/** Calendario: week grid on desktop, day agenda with a day strip on mobile (demo/mobile.html "Agenda"). */
export function CalendarView({ timezone, workStart, workEnd, clients, now: nowIso }: CalendarViewProps) {
  const t = useTranslations("calendario");
  const locale = useLocale();
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso]);
  const days = useMemo(() => weekDays(now, timezone), [now, timezone]);
  const range = useMemo(() => {
    const first = days[0] ?? now;
    return { from: addDays(first, -1).toISOString(), to: addDays(first, 8).toISOString() };
  }, [days, now]);
  const plan = usePlan(range);
  const events = useCalendarEvents(range);
  const tasks = useMemo(
    () => new Map<string, Task>((plan.data?.tasks ?? []).map((x) => [x.id, x])),
    [plan.data],
  );
  const perDay = useMemo(
    () => days.map((d) => dayItems(d, timezone, plan.data?.blocks ?? [], events.data?.items ?? [], tasks)),
    [days, timezone, plan.data, events.data, tasks],
  );
  const todayKey = dayKey(now, timezone);
  const nowMin = minuteOfDay(now.toISOString(), timezone);
  const startHour = Math.min(Math.floor(hhmm(workStart) / 60), 8);
  const endHour = Math.max(Math.ceil(hhmm(workEnd) / 60), 19);
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const y = (m: number) => ((m - startHour * 60) / 60) * HOUR_PX;
  const [dayIdx, setDayIdx] = useState(() =>
    Math.max(
      0,
      days.findIndex((d) => dayKey(d, timezone) === todayKey),
    ),
  );
  const dayLabel = (d: Date) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: timezone }).format(d);
  const timeLabel = (i: DayItem) =>
    `${formatTime(i.startsAt, locale, timezone)}–${formatTime(i.endsAt, locale, timezone)}`;

  return (
    <div>
      <div className="flex flex-wrap gap-4 text-[12.5px] text-ink3">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[11px] w-[22px] rounded border border-ink3 bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--rule)_4px_5px)]" />
          {t("legendMeetings")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[11px] w-[22px] rounded border-l-[3px] border-[var(--c-1)] bg-[color-mix(in_srgb,var(--c-1)_25%,var(--raised))]" />
          {t("legendBlocks")}
        </span>
        <span>{t("note")}</span>
      </div>
      {plan.isError || events.isError ? (
        <p role="alert" className="mt-3 text-risk">
          {t("error")}
        </p>
      ) : null}

      {/* Desktop week */}
      <div className="mt-3 hidden grid-cols-[48px_repeat(5,1fr)] md:grid" data-testid="week-view">
        <div />
        {days.map((d) => (
          <div
            key={d.toISOString()}
            className={cn(
              "border-b border-rule px-1.5 py-2 text-center font-semibold",
              dayKey(d, timezone) === todayKey && "text-sea",
            )}
          >
            {dayLabel(d)}
          </div>
        ))}
        <div className="relative" style={{ height: hours.length * HOUR_PX }}>
          {hours.map((h) => {
            const label = `${String(h).padStart(2, "0")}:00`;
            return (
              <span
                key={h}
                className="num absolute right-2 -translate-y-1/2 text-[11.5px] text-ink3"
                style={{ top: (h - startHour) * HOUR_PX }}
              >
                {label}
              </span>
            );
          })}
        </div>
        {perDay.map((items, i) => {
          const d = days[i];
          return (
            <div
              key={d?.toISOString() ?? String(i)}
              className="relative border-l border-rule bg-[linear-gradient(var(--rule)_1px,transparent_1px)] [background-size:100%_48px]"
              style={{ height: hours.length * HOUR_PX }}
            >
              {items.map((it) => (
                <div
                  key={it.id}
                  title={`${it.title} ${timeLabel(it)}`}
                  className={cn(
                    "absolute left-1 right-1 flex min-w-0 flex-col justify-center overflow-hidden rounded-lg px-1.5 py-0.5 text-left",
                    it.kind === "event" ? "border" : "border-0 border-l-4",
                    it.done && "opacity-50",
                  )}
                  style={{
                    top: y(it.startMin),
                    height: Math.max(14, y(it.endMin) - y(it.startMin)),
                    borderColor: clientColorVar(it.clientId, clients),
                    background:
                      it.kind === "event"
                        ? `repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, ${clientColorVar(it.clientId, clients)} 30%, transparent) 6px 7px)`
                        : `color-mix(in srgb, ${clientColorVar(it.clientId, clients)} 17%, var(--raised))`,
                  }}
                >
                  <b className="truncate text-[12.5px] font-semibold leading-tight">{it.title}</b>
                  {y(it.endMin) - y(it.startMin) > 40 ? (
                    <i className="num text-[11.5px] not-italic text-ink2">{timeLabel(it)}</i>
                  ) : null}
                </div>
              ))}
              {d && dayKey(d, timezone) === todayKey ? (
                <div
                  className="absolute inset-x-0 z-[2] h-0.5 bg-sea"
                  style={{ top: y(nowMin) }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Mobile agenda */}
      <div className="md:hidden" data-testid="agenda-view">
        <div className="mt-3 grid grid-cols-5 gap-1.5" role="tablist" aria-label={t("days")}>
          {days.map((d, i) => (
            <button
              key={d.toISOString()}
              type="button"
              role="tab"
              aria-selected={dayIdx === i}
              onClick={() => setDayIdx(i)}
              className={cn(
                "flex flex-col items-center rounded-[10px] border border-rule bg-raised py-1.5 text-[12px]",
                dayIdx === i && "border-sea bg-sea-soft text-sea",
                dayKey(d, timezone) === todayKey && "font-semibold",
              )}
            >
              <span>
                {new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: timezone }).format(d)}
              </span>
              <b className="num text-[15px]">
                {new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: timezone }).format(d)}
              </b>
            </button>
          ))}
        </div>
        <Agenda
          items={perDay[dayIdx] ?? []}
          isToday={dayKey(days[dayIdx] ?? now, timezone) === todayKey}
          nowMin={nowMin}
          nowLabel={formatTime(now.toISOString(), locale, timezone)}
          timeLabel={timeLabel}
          timezone={timezone}
          clients={clients}
        />
      </div>
    </div>
  );
}

function Agenda({
  items,
  isToday,
  nowMin,
  nowLabel,
  timeLabel,
  timezone,
  clients,
}: {
  items: DayItem[];
  isToday: boolean;
  nowMin: number;
  nowLabel: string;
  timeLabel: (i: DayItem) => string;
  timezone: string;
  clients: { id: string; name: string }[];
}) {
  const t = useTranslations("calendario");
  const locale = useLocale();
  if (items.length === 0 && !isToday) return <p className="py-6 text-ink2">{t("emptyDay")}</p>;
  const rows: React.ReactNode[] = [];
  let nowShown = false;
  const nowRow = (
    <div key="now" className="my-1 flex items-center gap-2 text-[11px] font-bold text-sea" aria-hidden="true">
      <em className="num rounded-full bg-sea px-1.5 not-italic text-on-sea">{nowLabel}</em>
      <div className="h-0.5 flex-1 bg-sea" />
    </div>
  );
  for (const it of items) {
    if (isToday && !nowShown && it.startMin > nowMin) {
      rows.push(nowRow);
      nowShown = true;
    }
    rows.push(
      <div key={it.id} className="grid grid-cols-[52px_1fr] gap-2 py-1">
        <div className="num pt-2 text-[12.5px] text-ink3">{formatTime(it.startsAt, locale, timezone)}</div>
        <div
          className={cn(
            "rounded-[10px] px-3 py-2",
            it.kind === "event" ? "border" : "border-0 border-l-4",
            it.done && "opacity-50",
          )}
          style={{
            borderColor: clientColorVar(it.clientId, clients),
            background:
              it.kind === "event"
                ? `repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, ${clientColorVar(it.clientId, clients)} 30%, transparent) 6px 7px)`
                : `color-mix(in srgb, ${clientColorVar(it.clientId, clients)} 17%, var(--raised))`,
          }}
        >
          <b className="block text-[14px]">{it.title}</b>
          <span className="num text-[12.5px] text-ink2">
            {timeLabel(it)}
            {it.kind === "event" ? `. ${t("fixed")}` : ""}
          </span>
        </div>
      </div>,
    );
  }
  if (isToday && !nowShown) rows.push(nowRow);
  if (items.length === 0)
    rows.push(
      <p key="empty" className="py-4 text-ink2">
        {t("emptyDay")}
      </p>,
    );
  return <div className="mt-3">{rows}</div>;
}
