"use client";

import { Mail } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FollowupDialog, type FollowupTarget } from "@/components/commitments/followup-dialog";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { formatDate } from "@/lib/format";
import { useCommitments } from "@/lib/hooks/use-api";
import { isOverdue } from "./commitment-list";

/** Hoy Q4 "¿Qué estoy esperando de otras personas?": open third-party commitments, overdue first (F-08). */
export function WaitingList({
  timezone,
  now: nowIso,
  gmailConnected,
}: {
  timezone: string;
  now?: string;
  gmailConnected: boolean;
}) {
  const t = useTranslations("commitments");
  const tHoy = useTranslations("hoy");
  const locale = useLocale();
  const now = nowIso ? new Date(nowIso) : new Date();
  const owed = useCommitments({ direction: "owed_to_me" });
  const [followup, setFollowup] = useState<FollowupTarget | null>(null);
  const items = (owed.data?.items ?? [])
    .filter((c) => c.status === "confirmed" || c.status === "at_risk")
    .sort(
      (a, b) =>
        Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""),
    )
    .slice(0, 6);
  if (owed.data && items.length === 0)
    return <p className="py-4 text-ink2">{gmailConnected ? t("emptyWaiting") : tHoy("emptyWaiting")}</p>;
  return (
    <>
      <ul className="divide-y divide-rule border-t border-rule">
        {items.map((c) => {
          const overdue = isOverdue(c, now);
          return (
            <li key={c.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-start">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{c.action}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                  <span>{c.counterpartyName ?? c.counterpartyEmail}</span>
                  <Pill variant={overdue ? "risk" : "plain"}>
                    {overdue ? t("status.overdue") : t("status.confirmed")}
                    {c.dueAt ? `, ${formatDate(c.dueAt, locale, timezone)}` : ""}
                  </Pill>
                </div>
              </div>
              {overdue ? (
                <div className="flex-shrink-0">
                  <Button
                    size="sm"
                    onClick={() =>
                      setFollowup({
                        commitmentId: c.id,
                        counterpartyName: c.counterpartyName,
                        counterpartyEmail: c.counterpartyEmail,
                      })
                    }
                  >
                    <Mail size={14} aria-hidden="true" />
                    {t("followup")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <FollowupDialog target={followup} onClose={() => setFollowup(null)} />
    </>
  );
}
