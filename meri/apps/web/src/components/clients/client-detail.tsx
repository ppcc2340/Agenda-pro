"use client";

import { FileText, Pencil } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { BriefingDialog } from "@/components/clients/briefing-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatDate, formatMinutes } from "@/lib/format";
import { useCalendarEvents, useCommitments, useTasks } from "@/lib/hooks/use-api";
import type { Client } from "@/lib/types";

interface TimelineItem {
  id: string;
  type: "task" | "commitment" | "event";
  title: string;
  date: string | null;
  status: string;
  risk: boolean;
  href: string;
}

const DAY = 86_400_000;

/** P3-08 client view: header, risks, month hours, briefing and a timeline built from the existing client filters. */
export function ClientDetail({ client, timezone, now: nowIso }: { client: Client; timezone: string; now?: string }) {
  const t = useTranslations("clientDetail");
  const tTasks = useTranslations("tasks");
  const locale = useLocale();
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso]);
  const range = useMemo(
    () => ({ from: new Date(now.getTime() - 45 * DAY).toISOString(), to: new Date(now.getTime() + 45 * DAY).toISOString() }),
    [now],
  );
  const tasks = useTasks({ includeCompleted: true });
  const commitments = useCommitments({ clientId: client.id });
  const events = useCalendarEvents(range);
  const [briefing, setBriefing] = useState(false);
  const hours = (min: number) => formatMinutes(min, (k, v) => tTasks(k, v));

  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    for (const x of tasks.data?.items ?? [])
      if (x.clientId === client.id)
        out.push({
          id: x.id,
          type: "task",
          title: x.title,
          date: x.dueAt,
          status: x.status,
          risk: x.status === "at_risk",
          href: `/proyectos?tab=tareas&clientId=${client.id}#task-${x.id}`,
        });
    for (const c of commitments.data?.items ?? [])
      out.push({
        id: c.id,
        type: "commitment",
        title: c.action,
        date: c.dueAt,
        status: c.status,
        risk: c.status === "at_risk" || (c.dueAt !== null && c.status === "confirmed" && new Date(c.dueAt) < now),
        href: `/proyectos?tab=compromisos&clientId=${client.id}#commitment-${c.id}`,
      });
    for (const e of events.data?.items ?? [])
      if (e.clientId === client.id && e.origin === "external")
        out.push({ id: e.id, type: "event", title: e.title ?? "", date: e.startsAt, status: new Date(e.endsAt) < now ? "past" : "upcoming", risk: false, href: "/calendario" });
    return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title));
  }, [tasks.data, commitments.data, events.data, client.id, now]);
  const risks = items.filter((i) => i.risk);
  const s = client.stats;
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start gap-4 rounded-2xl border border-rule bg-raised p-5" style={{ borderLeft: `6px solid ${client.color ?? "var(--sea)"}` }}>
        <div className="min-w-0 flex-1">
          <h2 className="font-head text-2xl font-semibold">{client.name}</h2>
          <p className="text-[13px] text-ink3">{client.domains.length ? client.domains.join(" · ") : t("noDomains")}</p>
          {client.verticalTags.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {client.verticalTags.map((tag) => (
                <Pill key={tag} variant="plain">
                  {tag}
                </Pill>
              ))}
            </div>
          ) : null}
          {client.notes ? <p className="mt-2 max-w-[70ch] whitespace-pre-line text-ink2">{client.notes}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setBriefing(true)}>
            <FileText size={14} aria-hidden="true" />
            {t("briefing")}
          </Button>
          <Button asChild>
            <Link href="/proyectos?tab=clientes">
              <Pencil size={14} aria-hidden="true" />
              {t("edit")}
            </Link>
          </Button>
        </div>
      </header>
      {s ? (
        <section aria-label={t("month")} className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-2xl border border-rule bg-raised px-4 py-3">
            <div className="text-[12.5px] text-ink2">{t("monthHours")}</div>
            <div className="num flex items-baseline gap-2">
              <b className="font-head text-2xl">{hours(s.minutesApproved)}</b>
              {s.minutesSuggested > 0 ? <span className="rounded-full border border-dashed border-sug px-2 text-[12.5px] text-sug">{t("suggested", { h: hours(s.minutesSuggested) })}</span> : null}
            </div>
          </div>
          <div className="rounded-2xl border border-rule bg-raised px-4 py-3">
            <div className="text-[12.5px] text-ink2">{t("openCommitments")}</div>
            <div className="num font-head text-2xl">
              {s.openCommitments}
              {s.overdueCommitments > 0 ? <span className="ml-2 text-[13px] text-risk">{t("overdue", { n: s.overdueCommitments })}</span> : null}
            </div>
          </div>
          <div className="rounded-2xl border border-rule bg-raised px-4 py-3">
            <div className="text-[12.5px] text-ink2">{t("atRisk")}</div>
            <div className={`num font-head text-2xl ${s.atRiskTasks > 0 ? "text-risk" : ""}`}>{s.atRiskTasks}</div>
          </div>
        </section>
      ) : null}
      {risks.length ? (
        <section aria-label={t("risks")}>
          <h3 className="mb-1.5 font-head text-[15.5px] font-semibold">{t("risks")}</h3>
          <ul className="grid gap-1">
            {risks.map((r) => (
              <li key={`${r.type}-${r.id}`} className="flex items-center gap-2 rounded-lg border-l-[3px] border-l-risk bg-risk-soft px-3 py-2">
                <Pill variant="risk">{t(`type.${r.type}`)}</Pill>
                <Link href={r.href} className="min-w-0 flex-1 truncate font-semibold underline-offset-2 hover:underline">
                  {r.title}
                </Link>
                {r.date ? <span className="num text-[12.5px] text-ink2">{formatDate(r.date, locale, timezone)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label={t("timeline")}>
        <h3 className="mb-1.5 font-head text-[15.5px] font-semibold">{t("timeline")}</h3>
        {items.length === 0 && !tasks.isPending ? <EmptyState title={t("emptyTitle")} body={t("emptyBody")} /> : null}
        <ol className="divide-y divide-rule border-t border-rule">
          {items.map((i) => (
            <li key={`${i.type}-${i.id}`} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="num w-[92px] text-[13px] text-ink2">{i.date ? formatDate(i.date, locale, timezone) : t("noDate")}</span>
              <Pill variant={i.type === "event" ? "sea" : i.risk ? "risk" : "plain"}>{t(`type.${i.type}`)}</Pill>
              <Link href={i.href} className="min-w-0 flex-1 truncate font-semibold underline-offset-2 hover:underline">
                {i.title}
              </Link>
              <span className="text-[12.5px] text-ink3">{t(`status.${i.status}`, { default: i.status })}</span>
            </li>
          ))}
        </ol>
      </section>
      <BriefingDialog target={briefing ? { clientId: client.id, clientName: client.name } : null} onClose={() => setBriefing(false)} />
    </div>
  );
}
