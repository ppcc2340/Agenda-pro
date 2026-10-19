"use client";

import { Check, Mail } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FollowupDialog, type FollowupTarget } from "@/components/commitments/followup-dialog";
import { Button } from "@/components/ui/button";
import { ClientChip } from "@/components/ui/client-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { keys, useApiMutation, useCommitments } from "@/lib/hooks/use-api";
import { clientColorVar } from "@/lib/plan";
import type { Commitment, CommitmentDirection, CommitmentStatus } from "@/lib/types";

const PILL: Record<CommitmentStatus, "plain" | "risk" | "ok" | "sug" | "sea"> = {
  proposed: "sug",
  confirmed: "plain",
  at_risk: "risk",
  broken: "risk",
  fulfilled: "ok",
  dismissed: "plain",
};

export const isOverdue = (c: Commitment, now: Date) =>
  c.status === "at_risk" ||
  (c.dueAt !== null && new Date(c.dueAt).getTime() < now.getTime() && c.status === "confirmed");

/** Compromisos tab (F-07, F-08; demo tabCompromisos): Debo / Me deben, client filter, states and follow-up. */
export function CommitmentList({
  clients,
  timezone,
  now: nowIso,
  initialDirection = "owed_by_me",
}: {
  clients: { id: string; name: string }[];
  timezone: string;
  now?: string;
  initialDirection?: CommitmentDirection;
}) {
  const t = useTranslations("commitments");
  const tApp = useTranslations("app");
  const tProyectos = useTranslations("proyectos");
  const locale = useLocale();
  const { toast } = useToast();
  const now = nowIso ? new Date(nowIso) : new Date();
  const [direction, setDirection] = useState<CommitmentDirection>(initialDirection);
  const [clientId, setClientId] = useState<string | null>(null);
  const [followup, setFollowup] = useState<FollowupTarget | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const all = useCommitments();
  const isOpen = (c: Commitment) =>
    c.status === "confirmed" || c.status === "at_risk" || c.status === "broken";
  const items = (all.data?.items ?? []).filter(
    (c) => c.direction === direction && (!clientId || c.clientId === clientId) && (showClosed || isOpen(c)),
  );
  const count = (d: CommitmentDirection) =>
    (all.data?.items ?? []).filter((c) => c.direction === d && isOpen(c)).length;
  const patch = useApiMutation(
    (vars: { id: string; status: CommitmentStatus }) =>
      clientApi<Commitment>(`/v1/commitments/${vars.id}`, { method: "PATCH", json: { status: vars.status } }),
    [["commitments"] as const, keys.audit],
  );

  return (
    <div>
      <div className="my-3.5 flex flex-wrap items-center gap-2">
        <div
          className="inline-flex overflow-hidden rounded-[10px] border border-rule bg-raised"
          role="group"
          aria-label={t("direction")}
        >
          {(["owed_by_me", "owed_to_me"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => setDirection(d)}
              className="px-3.5 py-1.5 font-semibold text-ink2 aria-pressed:bg-sea aria-pressed:text-on-sea"
            >
              {t(d, { n: count(d) })}
            </button>
          ))}
        </div>
        <span className="w-2" />
        {clients.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={clientId === c.id}
            onClick={() => setClientId(clientId === c.id ? null : c.id)}
            style={{ "--cc": clientColorVar(c.id, clients) } as React.CSSProperties}
            className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-raised px-2.5 py-1 text-[13px] aria-pressed:border-[var(--cc)] aria-pressed:bg-[color-mix(in_srgb,var(--cc)_14%,var(--raised))]"
          >
            <i aria-hidden="true" className="h-[9px] w-[9px] rounded-[3px] bg-[var(--cc)]" />
            {c.name}
          </button>
        ))}
        {clientId ? (
          <Button size="sm" variant="quiet" onClick={() => setClientId(null)}>
            {t("clearFilter")}
          </Button>
        ) : null}
        <button
          type="button"
          aria-pressed={showClosed}
          onClick={() => setShowClosed(!showClosed)}
          className="inline-flex items-center rounded-full border border-rule bg-raised px-2.5 py-1 text-[13px] aria-pressed:border-sea aria-pressed:bg-sea-soft"
        >
          {t("showClosed")}
        </button>
      </div>
      {all.isPending ? <p className="py-6 text-ink3">{tApp("loading")}</p> : null}
      {all.isError ? (
        <p role="alert" className="py-6 text-risk">
          {tApp("errorBody")}
        </p>
      ) : null}
      {all.data && items.length === 0 ? (
        <EmptyState
          title={all.data.items.length === 0 ? tProyectos("emptyTitle") : t("emptyFilter")}
          body={all.data.items.length === 0 ? tProyectos("emptyBody") : undefined}
        />
      ) : null}
      <ul className="divide-y divide-rule border-t border-rule">
        {items.map((c) => {
          const overdue = isOverdue(c, now);
          return (
            <li key={c.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:gap-4">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{c.action}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                  <ClientChip clientId={c.clientId} clients={clients} />
                  <span>{c.counterpartyName ?? c.counterpartyEmail ?? t("noCounterparty")}</span>
                  <Pill variant={overdue ? "risk" : PILL[c.status]}>
                    {overdue ? t("status.overdue") : t(`status.${c.status}`)}
                    {c.dueAt
                      ? `, ${formatDate(c.dueAt, locale, timezone)}`
                      : c.dueText
                        ? `, ${c.dueText}`
                        : ""}
                  </Pill>
                  <Pill variant="plain">{t(`kind.${c.kind}`)}</Pill>
                  {c.threadUrl ? (
                    <a
                      href={c.threadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {t("openThread")}
                    </a>
                  ) : null}
                </div>
                {c.evidence ? (
                  <p className="mt-1.5 border-l-2 border-rule pl-3 text-[13px] italic text-ink2">
                    {t("quote", { text: c.evidence })}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1.5">
                {c.status === "fulfilled" || c.status === "dismissed" ? null : c.direction ===
                  "owed_to_me" ? (
                  <>
                    <Button
                      size="sm"
                      variant={overdue ? "primary" : "default"}
                      onClick={() =>
                        setFollowup({
                          commitmentId: c.id,
                          counterpartyName: c.counterpartyName,
                          counterpartyEmail: c.counterpartyEmail,
                        })
                      }
                    >
                      <Mail size={14} aria-hidden="true" />
                      {t("prepareFollowup")}
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        patch.mutate(
                          { id: c.id, status: "fulfilled" },
                          { onSuccess: () => toast(t("toasts.received")) },
                        )
                      }
                    >
                      <Check size={14} aria-hidden="true" />
                      {t("received")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      patch.mutate(
                        { id: c.id, status: "fulfilled" },
                        { onSuccess: () => toast(t("toasts.fulfilled")) },
                      )
                    }
                  >
                    <Check size={14} aria-hidden="true" />
                    {t("fulfilled")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <FollowupDialog target={followup} onClose={() => setFollowup(null)} />
    </div>
  );
}
