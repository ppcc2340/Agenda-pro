"use client";

import { Check, Pin, PinOff } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatMinutes, formatTime } from "@/lib/format";
import { clientColorVar, type DayItem } from "@/lib/plan";
import type { Block, Task } from "@/lib/types";
import { useCompleteBlock, usePinBlock } from "./actions";
import { ReasonList } from "./reasons";

export interface TimelineProps {
  items: DayItem[];
  nowMin: number | null;
  nowIso: string;
  /** Proposal targets for today (dashed = suggested, docs/11). */
  ghosts?: {
    id: string;
    title: string;
    startMin: number;
    endMin: number;
    startsAt: string;
    endsAt: string;
  }[];
  /** Contingency reserve of the day (D-051): hatched at the end of the work day, never a block. */
  margin?: { startMin: number; endMin: number; minutes: number } | null;
  /** Visible window in minutes of the day (work hours ± 1 h). */
  window: { start: number; end: number };
  timezone: string;
  clients: { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** "Tu día": calendar lane (fixed meetings) above the plan lane (Meri blocks), with the now line. */
export function Timeline({
  items,
  nowMin,
  nowIso,
  ghosts = [],
  margin = null,
  window,
  timezone,
  clients,
  selectedId,
  onSelect,
}: TimelineProps) {
  const t = useTranslations("hoy");
  const locale = useLocale();
  const span = window.end - window.start;
  const x = (m: number) => `${String(Math.max(0, Math.min(100, ((m - window.start) / span) * 100)))}%`;
  const pct = (a: number, b: number) =>
    Math.max(2, Math.min(100, ((Math.min(b, window.end) - Math.max(a, window.start)) / span) * 100));
  const w = (a: number, b: number) => `${String(pct(a, b))}%`;
  const narrow = (a: number, b: number) => pct(a, b) < 9;
  const hours: number[] = [];
  for (let h = Math.ceil(window.start / 60); h <= Math.floor(window.end / 60); h++) hours.push(h);
  const events = items.filter((i) => i.kind === "event");
  const blocks = items.filter((i) => i.kind === "block");
  const label = (i: DayItem) =>
    `${formatTime(i.startsAt, locale, timezone)}–${formatTime(i.endsAt, locale, timezone)}`;
  return (
    <div className="relative mt-1 [--lanel:104px]">
      <div className="relative">
        <div className="relative ml-[var(--lanel)] h-5 text-xs text-ink3" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} className="absolute -translate-x-1/2" style={{ left: x(h * 60) }}>
              {h}
            </span>
          ))}
        </div>
        <Lane label={t("laneCalendar")} columns={hours.length - 1}>
          {events.map((e) => (
            <div
              key={e.id}
              className="absolute bottom-1 top-1 flex min-w-0 flex-col justify-center overflow-hidden rounded-lg border px-2 py-1 text-left"
              style={{
                left: x(e.startMin),
                width: w(e.startMin, e.endMin),
                borderColor: clientColorVar(e.clientId, clients),
                backgroundImage: `repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, ${clientColorVar(e.clientId, clients)} 30%, transparent) 6px 7px)`,
              }}
              title={e.title}
            >
              <b className="truncate text-[12.5px] font-semibold leading-tight">{e.title}</b>
              {narrow(e.startMin, e.endMin) ? null : (
                <i className="num text-[11.5px] not-italic text-ink2">{label(e)}</i>
              )}
            </div>
          ))}
        </Lane>
        <Lane label={t("lanePlan")} columns={hours.length - 1}>
          {margin && margin.endMin > margin.startMin ? (
            <div
              data-testid="margin"
              role="note"
              aria-label={t("marginTitle", { minutes: margin.minutes })}
              title={t("marginTitle", { minutes: margin.minutes })}
              className="absolute bottom-1 top-1 grid place-items-center rounded-lg border border-dashed border-ink3 bg-[repeating-linear-gradient(135deg,transparent_0_5px,var(--rule)_5px_6px)] text-[11px] text-ink3"
              style={{ left: x(margin.startMin), width: w(margin.startMin, margin.endMin) }}
            >
              {narrow(margin.startMin, margin.endMin) ? null : t("margin")}
            </div>
          ) : null}
          {ghosts.map((g) => {
            const ghostLabel = `${formatTime(g.startsAt, locale, timezone)}–${formatTime(g.endsAt, locale, timezone)}`;
            return (
              <div
                key={g.id}
                className="absolute bottom-1 top-1 flex min-w-0 flex-col justify-center overflow-hidden rounded-lg border border-dashed border-sug bg-sug-soft px-2 py-1 text-left text-sug"
                style={{ left: x(g.startMin), width: w(g.startMin, g.endMin) }}
                title={`${g.title} · ${t("legendSuggested")}`}
              >
                <b className="truncate text-[12.5px] font-semibold leading-tight">{g.title}</b>
                {narrow(g.startMin, g.endMin) ? null : (
                  <i className="num text-[11.5px] not-italic">{ghostLabel}</i>
                )}
              </div>
            );
          })}
          {blocks.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => onSelect(selectedId === b.id ? null : b.id)}
              aria-pressed={selectedId === b.id}
              aria-label={`${b.title}, ${label(b)}${b.done ? `, ${t("doneLabel")}` : ""}`}
              className={cn(
                "absolute bottom-1 top-1 flex min-w-0 flex-col justify-center overflow-hidden rounded-lg border-0 border-l-4 px-2 py-1 text-left text-ink transition-shadow",
                selectedId === b.id && "shadow-[0_0_0_2px_var(--cc)]",
              )}
              style={{
                left: x(b.startMin),
                width: w(b.startMin, b.endMin),
                ["--cc" as string]: clientColorVar(b.clientId, clients),
                borderLeftColor: "var(--cc)",
                background: "color-mix(in srgb, var(--cc) 17%, var(--raised))",
              }}
            >
              <b
                className={cn("truncate text-[12.5px] font-semibold leading-tight", b.done && "line-through")}
              >
                {b.title}
              </b>
              {narrow(b.startMin, b.endMin) ? null : (
                <i className="num text-[11.5px] not-italic text-ink2">{label(b)}</i>
              )}
            </button>
          ))}
        </Lane>
        {nowMin !== null && nowMin >= window.start && nowMin <= window.end ? (
          <div
            className="pointer-events-none absolute inset-y-0 left-[var(--lanel)] right-0"
            aria-hidden="true"
          >
            <div className="absolute -bottom-1 top-3.5 w-0.5 rounded bg-sea" style={{ left: x(nowMin) }}>
              <em className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-sea px-1.5 text-[11px] font-bold not-italic text-on-sea">
                {formatTime(nowIso, locale, timezone)}
              </em>
            </div>
          </div>
        ) : null}
      </div>
      <div className="ml-[var(--lanel)] mt-3 flex flex-wrap gap-4 text-[12.5px] text-ink3">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[11px] w-[22px] rounded border border-ink3 bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--rule)_4px_5px)]" />
          {t("legendFixed")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[11px] w-[22px] rounded border-l-[3px] border-[var(--c-1)] bg-[color-mix(in_srgb,var(--c-1)_25%,var(--raised))]" />
          {t("legendBlock")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[11px] w-[22px] rounded border border-dashed border-sug bg-sug-soft" />
          {t("legendSuggested")}
        </span>
      </div>
    </div>
  );
}

function Lane({ label, columns, children }: { label: string; columns: number; children: React.ReactNode }) {
  return (
    <div className="mt-2 grid grid-cols-[var(--lanel)_1fr] items-center">
      <span className="pr-2.5 text-[12.5px] font-semibold text-ink2">{label}</span>
      <div
        className="relative h-[60px] rounded-[10px] bg-[linear-gradient(90deg,var(--rule)_1px,transparent_1px)]"
        style={{ backgroundSize: `calc(100% / ${String(Math.max(1, columns))}) 100%` }}
      >
        {children}
      </div>
    </div>
  );
}

/** Selected block: why it is here, pin and mark done (undoable through Activity). */
export function BlockDetail({
  block,
  task,
  timezone,
  clients,
  onClose,
}: {
  block: Block;
  task: Task | undefined;
  timezone: string;
  clients: { id: string; name: string }[];
  onClose: () => void;
}) {
  const t = useTranslations("plan");
  const tTasks = useTranslations("tasks");
  const locale = useLocale();
  const { toast } = useToast();
  const tApp = useTranslations("app");
  const pin = usePinBlock();
  const complete = useCompleteBlock();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [block.id]);
  const minutes = Math.round(
    (new Date(block.endsAt).getTime() - new Date(block.startsAt).getTime()) / 60_000,
  );
  const headingId = `block-detail-${block.id}`;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-labelledby={headingId}
      className="ml-0 mt-4 flex flex-col gap-4 rounded-r-[10px] border-l-[3px] bg-panel px-4 py-3.5 outline-none md:ml-[var(--lanel)] md:flex-row md:items-start md:justify-between"
      style={{ borderLeftColor: clientColorVar(task?.clientId ?? null, clients) }}
    >
      <div>
        <h3 id={headingId} className="mb-0.5 text-base">
          {task?.title ?? ""}
        </h3>
        <p className="num text-ink2">
          {t("range", {
            from: formatTime(block.startsAt, locale, timezone),
            to: formatTime(block.endsAt, locale, timezone),
            duration: formatMinutes(minutes, (k, v) => tTasks(k, v)),
          })}{" "}
          {task?.kind === "deep" ? t("deep") : t("shallow")}
        </p>
        <p className="mt-1 max-w-[62ch] text-ink2">
          <b className="text-ink">{t("why")}</b> <ReasonList reasons={block.reason} />
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="quiet" onClick={onClose}>
          {tApp("dialogClose")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            pin.mutate(
              { id: block.id, pinned: !block.pinned },
              { onSuccess: () => toast(block.pinned ? t("toasts.unpinned") : t("toasts.pinned")) },
            );
          }}
          disabled={pin.isPending}
          aria-pressed={block.pinned}
        >
          {block.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
          {block.pinned ? t("unpin") : t("pin")}
        </Button>
        {block.completedAt ? null : (
          <Button
            size="sm"
            variant="primary"
            disabled={complete.isPending}
            onClick={() => {
              complete.mutate(
                { id: block.id, taskDone: true },
                {
                  onSuccess: () => {
                    toast(t("toasts.done"));
                    onClose();
                  },
                },
              );
            }}
          >
            <Check size={14} aria-hidden="true" />
            {t("markDone")}
          </Button>
        )}
      </div>
    </div>
  );
}
