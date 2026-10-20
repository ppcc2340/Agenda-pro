"use client";

import { FIGURE_METHODS } from "@meri/core";
import { ChevronDown } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { LoadError } from "@/components/ui/load-error";
import { Segmented } from "@/components/ui/segmented";
import { useValueReport } from "@/lib/hooks/use-api";
import { cn } from "@/lib/cn";
import type { ValueFigure } from "@/lib/types";

/** Where each source lives in the app (the user's own data, linked so every figure can be checked). */
const SOURCE_HREF: Record<string, string> = {
  task: "/proyectos",
  commitment: "/proyectos",
  time_entry: "/mas/tiempo",
};

function Figure({ figure }: { figure: ValueFigure }) {
  const t = useTranslations("value");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const id = `value-${figure.key}`;
  // With data, the methods that produced it; without, every method that could (so the figure is never a mystery).
  const methods = figure.methods.length > 0 ? figure.methods : FIGURE_METHODS[figure.key];
  return (
    <li className="rounded-2xl border border-rule bg-raised p-4">
      <p className="text-[13px] text-ink2">{t(`figures.${figure.key}`)}</p>
      {figure.value === null ? (
        <p className="mt-1 text-ink2">{t(`noData.${figure.key}`)}</p>
      ) : (
        <p className="mt-1">
          <b className="num font-head text-[28px] font-semibold">{format.number(figure.value)}</b>{" "}
          <span className="text-ink2">{t(`units.${figure.unit}`, { n: figure.value })}</span>
          {figure.estimated ? <span className="ml-2 text-[12.5px] text-ink3">{t("estimated")}</span> : null}
        </p>
      )}
      <button
        type="button"
        className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-sea"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {t("how")}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div id={id} className="mt-2 text-[13px]">
          <ul className="space-y-1 text-ink2">
            {methods.map((m) => (
              <li key={m}>{t(`methods.${m}`)}</li>
            ))}
          </ul>
          {figure.sources.length > 0 ? (
            <>
              <p className="mt-2 font-semibold">{t("sources", { n: figure.sources.length })}</p>
              <ul className="mt-1 space-y-1">
                {figure.sources.map((s) => (
                  <li key={`${s.type}:${s.id}`} className="flex justify-between gap-3">
                    <Link
                      href={SOURCE_HREF[s.type] ?? "/control"}
                      className="text-sea underline-offset-2 hover:underline"
                    >
                      {s.label ?? t(`sourceTypes.${s.type}`)}
                    </Link>
                    <span className="num shrink-0 text-ink3">
                      {figure.unit === "hours"
                        ? t("minutes", { n: s.quantity })
                        : format.dateTime(new Date(s.occurredAt), { dateStyle: "medium" })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** F-12 / D-063: three figures from verifiable facts, each with its method and sources; never an invented zero. */
export function ValueReportPanel() {
  const t = useTranslations("value");
  const [period, setPeriod] = useState<"week" | "month">("week");
  const report = useValueReport(period);
  return (
    <div>
      <Segmented
        label={t("period")}
        value={period}
        onChange={setPeriod}
        options={(["week", "month"] as const).map((p) => ({ value: p, label: t(`periods.${p}`) }))}
        className="mb-3"
      />
      {report.isPending ? (
        <p className="text-ink2">{t("loading")}</p>
      ) : report.data ? (
        <ul className="grid gap-3 md:grid-cols-3">
          {report.data.figures.map((f) => (
            <Figure key={f.key} figure={f} />
          ))}
        </ul>
      ) : (
        <LoadError message={t("unavailable")} onRetry={() => void report.refetch()} />
      )}
    </div>
  );
}
