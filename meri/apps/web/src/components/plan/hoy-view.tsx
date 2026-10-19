"use client";

import { Check, NotebookPen } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientChip } from "@/components/ui/client-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { Section } from "@/components/ui/section";
import { useToast } from "@/components/ui/toast";
import { formatDate, formatDateTime, formatMinutes, formatTime } from "@/lib/format";
import { useCalendarEvents, usePlan } from "@/lib/hooks/use-api";
import {
  addDays,
  clientColorVar,
  currentBlock,
  dayItems,
  dayKey,
  minuteOfDay,
  startOfLocalDay,
  type DayItem,
} from "@/lib/plan";
import type { Task } from "@/lib/types";
import { AgreementsDialog, type AgreementsTarget } from "@/components/calendar/agreements-dialog";
import { WaitingList } from "@/components/commitments/waiting-list";
import { useCompleteBlock } from "./actions";
import { ReasonList } from "./reasons";
import { RiskList } from "./risk-list";
import { BlockDetail, Timeline } from "./timeline";

export interface HoyViewProps {
  timezone: string;
  workStart: string;
  workEnd: string;
  clients: { id: string; name: string }[];
  /** Injected clock (DEMO_NOW) as ISO; defaults to the browser clock. */
  now?: string;
  pendingTasks: Task[];
  gmailConnected?: boolean;
}

const hhmm = (s: string) => {
  const [h = "0", m = "0"] = s.split(":");
  return Number(h) * 60 + Number(m);
};

/** "Hoy": day line + the four questions, fed by the persisted plan (never planned on request). */
export function HoyView({
  timezone,
  workStart,
  workEnd,
  clients,
  now: nowIso,
  pendingTasks,
  gmailConnected = false,
}: HoyViewProps) {
  const t = useTranslations("hoy");
  const tPlan = useTranslations("plan");
  const tTasks = useTranslations("tasks");
  const tApp = useTranslations("app");
  const locale = useLocale();
  const { toast } = useToast();
  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso]);
  const dayStart = useMemo(() => startOfLocalDay(now, timezone), [now, timezone]);
  const range = useMemo(
    () => ({ from: addDays(dayStart, -1).toISOString(), to: addDays(dayStart, 2).toISOString() }),
    [dayStart],
  );
  const plan = usePlan(range);
  const events = useCalendarEvents(range);
  const [selected, setSelected] = useState<string | null>(null);
  const [agreements, setAgreements] = useState<AgreementsTarget | null>(null);
  const complete = useCompleteBlock();

  const tasks = useMemo(
    () => new Map<string, Task>((plan.data?.tasks ?? []).map((x) => [x.id, x])),
    [plan.data],
  );
  const items = useMemo(
    () => dayItems(now, timezone, plan.data?.blocks ?? [], events.data?.items ?? [], tasks),
    [now, timezone, plan.data, events.data, tasks],
  );
  const nowMin = minuteOfDay(now.toISOString(), timezone);
  const ghosts = useMemo(() => {
    const p = plan.data?.pendingProposal;
    if (!p) return [];
    const todayKey = dayKey(now, timezone);
    const targets = [
      ...p.added.map((a) => ({ taskId: a.taskId, startsAt: a.startsAt, endsAt: a.endsAt })),
      ...p.moved.map((m) => ({ taskId: m.taskId, startsAt: m.to.startsAt, endsAt: m.to.endsAt })),
    ];
    return targets
      .filter((g) => dayKey(new Date(g.startsAt), timezone) === todayKey)
      .map((g) => ({
        id: `ghost-${g.taskId}-${g.startsAt}`,
        title: tasks.get(g.taskId)?.title ?? "",
        startMin: minuteOfDay(g.startsAt, timezone),
        endMin: minuteOfDay(g.endsAt, timezone),
        startsAt: g.startsAt,
        endsAt: g.endsAt,
      }));
  }, [plan.data, now, timezone, tasks]);
  const current = currentBlock(items, nowMin);
  const priorityOf = (i: DayItem) => tasks.get(i.taskId ?? "")?.priority ?? 3;
  const key = items
    .filter((i) => i.kind === "block" && !i.done)
    .sort((a, b) => priorityOf(a) - priorityOf(b) || a.startMin - b.startMin)
    .slice(0, 3);
  const window = {
    start: Math.min(hhmm(workStart), 8 * 60) - 60,
    end: Math.max(hhmm(workEnd), 18 * 60) + 60,
  };
  const selectedBlock = plan.data?.blocks.find((b) => b.id === selected) ?? null;
  const riskCount = plan.data ? plan.data.risks.length + plan.data.conflicts.length : 0;
  const scheduledIds = new Set((plan.data?.blocks ?? []).map((b) => b.taskId));
  const nextBlock = (plan.data?.blocks ?? [])
    .filter((b) => b.completedAt === null && new Date(b.startsAt).getTime() > now.getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const unscheduled = pendingTasks.filter((x) => !scheduledIds.has(x.id));

  const markDone = (b: DayItem) => {
    complete.mutate({ id: b.id, taskDone: true }, { onSuccess: () => toast(tPlan("toasts.done")) });
  };

  return (
    <>
      <p className="-mt-3 mb-5 text-ink2">
        {plan.isPending
          ? tApp("loading")
          : plan.data && plan.data.blocks.length > 0
            ? plan.data.conflicts.length > 0
              ? t("subtitleConflict", { n: riskCount })
              : riskCount > 0
                ? t("subtitleRisk", { n: riskCount })
                : t("subtitleCalm")
            : t("subtitleEmpty")}
      </p>
      {/* The day line is a desktop view (demo/mobile.html keeps the day in the Agenda tab). */}
      <Section title={t("dayLine")} className="mt-0 hidden md:block">
        {plan.isError ? (
          <p role="alert" className="flex items-center gap-3 text-risk">
            {t("errorPlan")}
            <Button size="sm" onClick={() => void plan.refetch()}>
              {tApp("retry")}
            </Button>
          </p>
        ) : null}
        <Timeline
          items={items}
          nowMin={nowMin}
          nowIso={now.toISOString()}
          ghosts={ghosts}
          window={window}
          timezone={timezone}
          clients={clients}
          selectedId={selected}
          onSelect={setSelected}
        />
        {selectedBlock ? (
          <BlockDetail
            block={selectedBlock}
            task={tasks.get(selectedBlock.taskId)}
            timezone={timezone}
            clients={clients}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </Section>
      <div className="mt-1.5 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <Section title={t("q1")} className="mt-2">
            {plan.isPending ? (
              <p className="py-4 text-ink3">{tApp("loading")}</p>
            ) : current ? (
              <NowCard
                block={current}
                nowMin={nowMin}
                timezone={timezone}
                clients={clients}
                reasons={plan.data?.blocks.find((b) => b.id === current.id)?.reason ?? []}
                onDone={() => markDone(current)}
                onWhy={() => setSelected(current.id)}
              />
            ) : plan.data && plan.data.blocks.length > 0 ? (
              <EmptyState
                title={t("doneTodayTitle")}
                body={
                  nextBlock
                    ? t("nextBlock", {
                        title: tasks.get(nextBlock.taskId)?.title ?? "",
                        when: formatDateTime(nextBlock.startsAt, locale, timezone),
                      })
                    : t("doneTodayBody")
                }
              />
            ) : (
              <EmptyState title={t("emptyNowTitle")} body={t("emptyNowBody")} />
            )}
          </Section>
          <Section title={t("q2")}>
            {key.length === 0 ? (
              <p className="py-4 text-ink2">{t("emptyImportant")}</p>
            ) : (
              <ul className="divide-y divide-rule border-t border-rule">
                {key.map((b) => (
                  <li key={b.id} className="flex items-start gap-3 py-3">
                    <button
                      type="button"
                      className="relative mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-[7px] border-[1.5px] border-ink3 bg-raised p-0 text-transparent before:absolute before:-inset-3 before:content-['']"
                      aria-label={t("markDoneAria", { title: b.title })}
                      onClick={() => markDone(b)}
                    >
                      <Check size={14} aria-hidden="true" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{b.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                        <ClientChip clientId={b.clientId} clients={clients} />
                        <span className="num">
                          {formatTime(b.startsAt, locale, timezone)}–{formatTime(b.endsAt, locale, timezone)}
                        </span>
                        {b.pinned ? <Pill variant="plain">{tPlan("pinned")}</Pill> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {unscheduled.length > 0 ? (
            <Section title={t("unscheduled")}>
              <ul className="divide-y divide-rule border-t border-rule">
                {unscheduled.map((task) => (
                  <li key={task.id} className="py-3">
                    <div className="font-semibold">{task.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
                      <ClientChip clientId={task.clientId} clients={clients} />
                      {task.dueAt ? (
                        <span className="num">
                          {tTasks("due", { date: formatDate(task.dueAt, locale, timezone) })}
                        </span>
                      ) : null}
                      {task.estimateMinutes ? (
                        <span className="num">
                          {formatMinutes(task.estimateMinutes, (k, v) => tTasks(k, v))}
                        </span>
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
            {plan.data ? (
              <RiskList plan={plan.data} clients={clients} timezone={timezone} />
            ) : (
              <EmptyState title={t("emptyRisksTitle")} body={t("emptyRisksBody")} />
            )}
          </Section>
          <Section title={t("q4")}>
            <WaitingList timezone={timezone} now={nowIso} gmailConnected={gmailConnected} clients={clients} />
          </Section>
          {items.some((i) => i.kind === "event" && i.clientId) ? (
            <Section title={t("meetings.title")}>
              <ul className="divide-y divide-rule">
                {items
                  .filter((i) => i.kind === "event" && i.clientId)
                  .map((ev) => {
                    const clientName = clients.find((c) => c.id === ev.clientId)?.name ?? null;
                    return (
                      <li key={ev.id} className="flex flex-wrap items-center gap-3 py-2.5">
                        <span className="num text-[13px] text-ink2">{formatTime(ev.startsAt, locale, timezone)}</span>
                        <span className="min-w-0 flex-1 truncate font-semibold">{ev.title}</span>
                        <span className="text-[12.5px] text-ink2">
                          <ClientChip clientId={ev.clientId} clients={clients} name={clientName} />
                        </span>
                        <Button
                          size="sm"
                          variant={ev.endMin <= nowMin ? "primary" : "default"}
                          onClick={() => setAgreements({ eventId: ev.id, title: ev.title, clientName })}
                        >
                          <NotebookPen size={14} aria-hidden="true" />
                          {t("meetings.record")}
                        </Button>
                      </li>
                    );
                  })}
              </ul>
            </Section>
          ) : null}
          <AgreementsDialog target={agreements} onClose={() => setAgreements(null)} />
        </div>
      </div>
    </>
  );
}


function NowCard({
  block,
  nowMin,
  timezone,
  clients,
  reasons,
  onDone,
  onWhy,
}: {
  block: DayItem;
  nowMin: number;
  timezone: string;
  clients: { id: string; name: string }[];
  reasons: { code: string; params: Record<string, unknown> }[];
  onDone: () => void;
  onWhy: () => void;
}) {
  const t = useTranslations("hoy");
  const tPlan = useTranslations("plan");
  const tTasks = useTranslations("tasks");
  const locale = useLocale();
  const live = block.startMin <= nowMin;
  const pct = live ? Math.round(((nowMin - block.startMin) / (block.endMin - block.startMin)) * 100) : 0;
  const fmt = (m: number) => formatMinutes(m, (k, v) => tTasks(k, v));
  return (
    <div
      className="rounded-xl border border-rule border-l-[5px] bg-raised px-5 py-4"
      style={{ borderLeftColor: clientColorVar(block.clientId, clients) }}
    >
      <ClientChip clientId={block.clientId} clients={clients} />
      <h3 className="my-1.5 text-[22px]">{block.title}</h3>
      <p className="num text-ink2">
        {live
          ? t("nowRemaining", { time: fmt(block.endMin - nowMin) })
          : t("nowStarts", {
              time: formatTime(block.startsAt, locale, timezone),
              duration: fmt(block.endMin - block.startMin),
            })}
      </p>
      <div className="my-3 h-1.5 max-w-[420px] overflow-hidden rounded-full bg-rule">
        <b
          className="block h-full"
          style={{ width: `${String(pct)}%`, background: clientColorVar(block.clientId, clients) }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onDone}>
          <Check size={16} aria-hidden="true" />
          {tPlan("markDone")}
        </Button>
        <Button onClick={onWhy}>{t("whyHere")}</Button>
      </div>
      <p className="mt-2.5 text-[13px] text-ink3 md:hidden">
        <b className="text-ink2">{t("whyNow")}</b> <ReasonList reasons={reasons} />
      </p>
    </div>
  );
}
