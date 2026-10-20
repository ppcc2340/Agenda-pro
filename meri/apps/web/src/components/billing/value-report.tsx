"use client";

import { ChevronDown } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
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
  return (
    <li className="rounded-2xl border border-rule bg-raised p-4">
      <p className="text-[13px] text-ink2">{t(`figures.${figure.key}`)}</p>
      {figure.value === null ? (
        <p className="mt-1 text-ink2">{t("noData")}</p>
      ) : (
        <p className="mt-1">
          <b className="num font-head text-[28px] font-semibold">{format.number(figure.value)}</b>{" "}
          <span className="text-ink2">{t(`units.${figure.unit}`, { n: figure.value })}</span>
          {figure.estimated ? <span className="ml-2 text-[12.5px] text-ink3">{t("estimated")}</span> : null}
        </p>
      )}
      {figure.value !== null ? (
        <>
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
                {figure.methods.map((m) => (
                  <li key={m}>{t(`methods.${m}`)}</li>
                ))}
              </ul>
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
            </div>
          ) : null}
        </>
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
      <div
        role="radiogroup"
        aria-label={t("period")}
        className="mb-3 inline-flex rounded-xl border border-rule p-1"
      >
        {(["week", "month"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={period === p}
            onClick={() => setPeriod(p)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-semibold",
              period === p ? "bg-sea text-on-sea" : "text-ink2",
            )}
          >
            {t(`periods.${p}`)}
          </button>
        ))}
      </div>
      {report.isPending ? (
        <p className="text-ink2">{t("loading")}</p>
      ) : report.data ? (
        <ul className="grid gap-3 md:grid-cols-3">
          {report.data.figures.map((f) => (
            <Figure key={f.key} figure={f} />
          ))}
        </ul>
      ) : (
        <p className="text-ink2">{t("unavailable")}</p>
      )}
    </div>
  );
}
