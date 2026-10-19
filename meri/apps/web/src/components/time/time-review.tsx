"use client";

import { Check, ChevronLeft, ChevronRight, Download, Pencil, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientChip } from "@/components/ui/client-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDate, formatMinutes } from "@/lib/format";
import { idempotencyKey, keys, useApiMutation, useTimeWeek } from "@/lib/hooks/use-api";
import type { CalendarEvent, TimeEntry } from "@/lib/types";

/** ISO week key arithmetic on the client: the API resolves the week in the user's time zone. */
export function shiftWeek(key: string, delta: number): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return key;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (Number(m[2]) - 1 + delta) * 7 * 86_400_000);
  const d = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${String(d.getUTCFullYear())}-W${String(week).padStart(2, "0")}`;
}

/** Tiempo tab (F-10 AC1, demo tabTiempo): weekly summary per client, review in batch, unassigned meetings, CSV. */
export function TimeReview({ clients, timezone }: { clients: { id: string; name: string }[]; timezone: string }) {
  const t = useTranslations("time");
  const tTasks = useTranslations("tasks");
  const tApp = useTranslations("app");
  const locale = useLocale();
  const { toast } = useToast();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const query = useTimeWeek(week);
  const data = query.data;
  const hours = (min: number) => formatMinutes(min, (k, v) => tTasks(k, v));
  const invalidate = [keys.time, keys.audit, keys.clients];
  const approveBatch = useApiMutation(
    (ids: string[]) =>
      clientApi<{ approved: string[] }>("/v1/time-entries/approve-batch", { method: "POST", json: { ids }, headers: { "idempotency-key": idempotencyKey() } }),
    invalidate,
    { onSuccess: (r) => toast(t("toasts.approved", { n: r.approved.length })) },
  );
  const one = useApiMutation(
    ({ id, action }: { id: string; action: "approve" | "reject" }) =>
      clientApi<TimeEntry>(`/v1/time-entries/${id}/${action}`, { method: "POST" }),
    invalidate,
    { onSuccess: (_e, v) => toast(v.action === "approve" ? t("toasts.approved", { n: 1 }) : t("toasts.rejected")) },
  );
  const patch = useApiMutation(
    ({ id, minutes }: { id: string; minutes: number }) =>
      clientApi<TimeEntry>(`/v1/time-entries/${id}`, { method: "PATCH", json: { minutes } }),
    invalidate,
    { onSuccess: () => { setEditing(null); toast(t("toasts.updated")); } },
  );
  const assign = useApiMutation(
    ({ id, clientId }: { id: string; clientId: string }) =>
      clientApi<CalendarEvent>(`/v1/calendar/events/${id}`, { method: "PATCH", json: { clientId } }),
    [keys.time, keys.audit],
    { onSuccess: () => toast(t("toasts.assigned")) },
  );
  const suggested = useMemo(() => (data?.items ?? []).filter((i) => i.status === "suggested"), [data]);
  const totals = useMemo(
    () => ({
      approved: (data?.summary ?? []).reduce((sum, s) => sum + s.minutesApproved, 0),
      suggested: (data?.summary ?? []).reduce((sum, s) => sum + s.minutesSuggested, 0),
    }),
    [data],
  );
  const current = data?.week ?? week ?? "";
  const range = data ? `${formatDate(`${data.days[0] ?? ""}T12:00:00`, locale)} – ${formatDate(`${data.days[6] ?? ""}T12:00:00`, locale)}` : "";
  return (
    <div>
      <div className="my-3.5 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center overflow-hidden rounded-[10px] border border-rule bg-raised">
          <button type="button" aria-label={t("prevWeek")} className="px-2 py-1.5" onClick={() => setWeek(shiftWeek(current, -1))} disabled={!current}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="num px-2 text-[13px] font-semibold">
            {t("week", { week: current })} <span className="font-normal text-ink2">{range}</span>
          </span>
          <button type="button" aria-label={t("nextWeek")} className="px-2 py-1.5" onClick={() => setWeek(shiftWeek(current, 1))} disabled={!current}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <span className="w-2" />
        <Button
          variant="primary"
          size="sm"
          disabled={suggested.length === 0 || approveBatch.isPending}
          onClick={() => approveBatch.mutate(suggested.map((i) => i.id))}
        >
          <Check size={14} aria-hidden="true" />
          {t("approveAll", { n: suggested.length })}
        </Button>
        <Button size="sm" asChild>
          <a href={`/api/v1/time-entries/export.csv?week=${encodeURIComponent(current)}`} download>
            <Download size={14} aria-hidden="true" />
            {t("exportCsv")}
          </a>
        </Button>
      </div>
      {query.isPending ? <p className="py-6 text-ink3">{tApp("loading")}</p> : null}
      {query.isError ? (
        <p role="alert" className="py-6 text-risk">
          {tApp("errorBody")}
        </p>
      ) : null}
      {data ? (
        <>
          <section aria-label={t("stats")} className="mb-4 grid grid-cols-2 gap-2 sm:max-w-[520px]">
            <div className="rounded-2xl border border-rule bg-raised px-4 py-3">
              <b className="num block font-head text-[28px] font-semibold leading-tight">{hours(totals.approved)}</b>
              <span className="text-[12.5px] text-ink2">
                <span className="md:hidden">{t("statApprovedShort")}</span>
                <span className="hidden md:inline">{t("statApproved")}</span>
              </span>
            </div>
            <div className="rounded-2xl border border-dashed border-sug bg-raised px-4 py-3">
              <b className="num block font-head text-[28px] font-semibold leading-tight text-sug">{hours(totals.suggested)}</b>
              <span className="text-[12.5px] text-ink2">
                <span className="md:hidden">{t("statSuggestedShort")}</span>
                <span className="hidden md:inline">{t("statSuggested")}</span>
              </span>
            </div>
          </section>
          <section aria-label={t("summary")} className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {data.summary.length === 0 ? <p className="text-ink2">{t("summaryEmpty")}</p> : null}
            {data.summary.map((s) => (
              <div key={s.clientId ?? "none"} className="rounded-2xl border border-rule bg-raised px-4 py-3">
                <div className="font-semibold">
                  <ClientChip clientId={s.clientId} clients={clients} name={s.clientName ?? t("noClient")} />
                </div>
                <div className="num mt-1 flex items-baseline gap-2">
                  <b className="font-head text-xl">{hours(s.minutesApproved)}</b>
                  <span className="text-[12.5px] text-ink2">{t("approved")}</span>
                  {s.minutesSuggested > 0 ? (
                    <span className="rounded-full border border-dashed border-sug px-2 text-[12.5px] text-sug">
                      {t("suggested", { h: hours(s.minutesSuggested) })}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </section>
          {data.items.length === 0 && data.unassignedEvents.length === 0 ? (
            <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
          ) : null}
          <ul className="divide-y divide-rule border-t border-rule" aria-label={t("entries")}>
            {data.items.map((e) => {
              const pending = e.status === "suggested";
              return (
                <li
                  key={e.id}
                  className={`flex flex-col gap-2 py-3 md:flex-row md:items-center md:gap-4 ${pending ? "border-l-[3px] border-l-dashed border-l-sug pl-3" : "border-l-[3px] border-l-sea pl-3"}`}
                >
                  <span className="num w-[92px] text-[13px] text-ink2">{formatDate(`${e.day}T12:00:00`, locale)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{e.description || t("noDescription")}</div>
                    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink2">
                      <ClientChip clientId={e.clientId} clients={clients} name={e.clientName} />
                      <span>{t(`source.${e.sourceType === "calendar_event" ? "event" : e.sourceType === "schedule_block" ? "block" : "other"}`)}</span>
                      <Pill variant={pending ? "sug" : e.status === "rejected" ? "risk" : "ok"}>{t(`status.${e.status}`)}</Pill>
                    </div>
                  </div>
                  {editing === e.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const v = Number(new FormData(ev.currentTarget).get("minutes"));
                        if (v > 0) patch.mutate({ id: e.id, minutes: v });
                      }}
                    >
                      <input name="minutes" type="number" min={1} max={1440} defaultValue={e.minutes} aria-label={t("minutes")} className="num w-20 rounded-lg border border-rule bg-panel px-2 py-1" />
                      <Button size="sm" type="submit" disabled={patch.isPending}>{t("save")}</Button>
                      <Button size="sm" variant="quiet" type="button" onClick={() => setEditing(null)}>{t("cancel")}</Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="num inline-flex items-center gap-1 text-[15px] font-semibold underline-offset-2 hover:underline"
                      onClick={() => setEditing(e.id)}
                      aria-label={t("editAria", { h: hours(e.minutes) })}
                    >
                      {hours(e.minutes)}
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  )}
                  {pending ? (
                    <div className="flex gap-1">
                      <Button size="sm" disabled={one.isPending} onClick={() => one.mutate({ id: e.id, action: "approve" })}>
                        <Check size={14} aria-hidden="true" />
                        {t("approve")}
                      </Button>
                      <Button size="sm" variant="quiet" disabled={one.isPending} onClick={() => one.mutate({ id: e.id, action: "reject" })}>
                        <X size={14} aria-hidden="true" />
                        {t("reject")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[12.5px] text-ink3">{t("note")}</p>
          {data.unassignedEvents.length > 0 ? (
            <section aria-label={t("unassignedTitle")} className="mt-5">
              <h3 className="mb-1 font-head text-[15.5px] font-semibold">{t("unassignedTitle")}</h3>
              <p className="mb-2 text-[13px] text-ink2">{t("unassignedBody")}</p>
              <ul className="divide-y divide-rule border-t border-rule">
                {data.unassignedEvents.map((ev) => (
                  <li key={ev.id} className="flex flex-col gap-2 py-2.5 md:flex-row md:items-center md:gap-4">
                    <span className="num w-[92px] text-[13px] text-ink2">{formatDate(ev.startsAt, locale, timezone)}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{ev.title || t("noDescription")}</span>
                    <span className="num text-[13px] text-ink2">{hours(ev.minutes)}</span>
                    <Pill variant="plain">{t("unassignedPill")}</Pill>
                    <select
                      aria-label={t("assignClient")}
                      className="rounded-lg border border-rule bg-panel px-2 py-1 text-[13px]"
                      defaultValue=""
                      disabled={assign.isPending}
                      onChange={(e) => e.target.value && assign.mutate({ id: ev.id, clientId: e.target.value })}
                    >
                      <option value="">{t("assignClient")}</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
