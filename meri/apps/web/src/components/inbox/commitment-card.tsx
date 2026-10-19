"use client";

import { Check, ExternalLink, Mail, Pencil, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { formatDateTime, isoToLocalInput, localInputToIso } from "@/lib/format";
import type { CommitmentPayload, FollowupPayload, Proposal } from "@/lib/types";

const CARD =
  "flex flex-col gap-3 border-b border-rule border-l-[3px] border-l-dashed border-l-sug bg-[linear-gradient(90deg,var(--sug-soft),transparent_30%)] px-4 py-4 md:flex-row md:items-start md:gap-4";

export function Confidence({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="inline-block h-1.5 w-11 overflow-hidden rounded-full bg-rule">
        <b className="block h-full bg-sea" style={{ width: `${String(Math.round(value * 100))}%` }} />
      </span>
      <span className="num">{Math.round(value * 100)} %</span>
    </span>
  );
}

/**
 * Entrada card for a `commitment` proposal (F-07): quote ≤ 200 chars, link to the Gmail thread, confidence,
 * direction and counterparty; confirm (optionally with edits and a "waiting for" task), dismiss. Keyboard friendly.
 */
export function CommitmentCard({
  proposal,
  timezone,
  busy,
  onConfirm,
  onDismiss,
}: {
  proposal: Proposal;
  timezone: string;
  busy: boolean;
  onConfirm: (edits?: { action?: string; dueAt?: string | null; createWaitingTask?: boolean }) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("inbox");
  const tc = useTranslations("commitments");
  const locale = useLocale();
  const p = proposal.payload as unknown as CommitmentPayload;
  const [editing, setEditing] = useState(false);
  const formId = `edit-${proposal.id}`;
  const who = p.counterpartyName ?? p.counterpartyEmail ?? "";
  return (
    <article className={CARD} aria-label={p.action}>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
          <Pill variant={p.direction === "owed_to_me" ? "sea" : "plain"}>
            {tc(`directionLabel.${p.direction}`)}
          </Pill>
          <span>
            {p.direction === "owed_to_me" ? t("commitment.from", { who }) : t("commitment.to", { who })}
          </span>
        </div>
        {editing ? (
          <form
            id={formId}
            className="grid gap-2 sm:grid-cols-[2fr_1fr]"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const str = (k: string) => {
                const v = fd.get(k);
                return typeof v === "string" ? v.trim() : "";
              };
              const due = str("dueAt");
              onConfirm({
                action: str("action") || p.action,
                dueAt: due ? localInputToIso(due, timezone) : null,
                createWaitingTask: fd.get("waiting") === "on",
              });
            }}
          >
            <input
              name="action"
              defaultValue={p.action}
              aria-label={t("editAction")}
              className="rounded-lg border border-rule bg-raised px-2.5 py-1.5"
            />
            <input
              name="dueAt"
              type="datetime-local"
              defaultValue={p.dueAt ? isoToLocalInput(p.dueAt, timezone) : ""}
              aria-label={t("editDate")}
              className="num rounded-lg border border-rule bg-raised px-2.5 py-1.5"
            />
            {p.direction === "owed_to_me" ? (
              <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
                <input type="checkbox" name="waiting" defaultChecked />
                {t("commitment.waitingTask")}
              </label>
            ) : null}
          </form>
        ) : (
          <div className="text-[15.5px] font-semibold">{p.action}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
          <span className="num">
            {p.dueAt
              ? t("forDate", { date: formatDateTime(p.dueAt, locale, timezone) })
              : (p.dueText ?? t("noDate"))}
          </span>
          <Pill variant="sug">{t("kind.commitment")}</Pill>
          <Pill variant="plain">{t(`kind.${p.kind}`)}</Pill>
          <Confidence value={proposal.confidence} />
          {proposal.sourceRef?.url ? (
            <a
              href={proposal.sourceRef.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <ExternalLink size={13} aria-hidden="true" />
              {t("commitment.openThread")}
            </a>
          ) : null}
        </div>
        <p className="mt-2 border-l-2 border-rule pl-3 text-[13px] italic text-ink2">
          {t("quote", { text: p.evidence })}
        </p>
        {p.subject ? <p className="mt-1 text-[12.5px] text-ink3">{p.subject}</p> : null}
      </div>
      <div className="flex shrink-0 gap-1.5 md:min-w-[150px] md:flex-col">
        {editing ? (
          <>
            <Button variant="primary" size="sm" type="submit" form={formId} disabled={busy}>
              {t("actions.saveConfirm")}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              {t("actions.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onConfirm()}>
              <Check size={14} aria-hidden="true" />
              {t("actions.confirm")}
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden="true" />
              {t("actions.edit")}
            </Button>
            <Button size="sm" variant="quiet" disabled={busy} onClick={onDismiss}>
              <X size={14} aria-hidden="true" />
              {t("actions.dismiss")}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/** Entrada card for a `followup` proposal (F-08 AC1): one alert per overdue commitment or unanswered thread. */
export function FollowupCard({
  proposal,
  timezone,
  onFollowup,
  onDismiss,
}: {
  proposal: Proposal;
  timezone: string;
  onFollowup: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("inbox");
  const locale = useLocale();
  const p = proposal.payload as unknown as FollowupPayload;
  const who = p.counterpartyName ?? p.counterpartyEmail ?? "";
  return (
    <article className={CARD} aria-label={t("followup.title", { who })}>
      <div className="min-w-0 flex-1">
        <div className="text-[15.5px] font-semibold">
          {p.kind === "overdue_commitment"
            ? t("followup.overdue", { who, action: p.action, days: p.daysLate })
            : t("followup.unanswered", { who, days: p.daysLate })}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
          {p.dueAt ? (
            <span className="num">{t("forDate", { date: formatDateTime(p.dueAt, locale, timezone) })}</span>
          ) : null}
          {p.subject ? <span>{p.subject}</span> : null}
          {p.clientName ? <span>{p.clientName}</span> : null}
          <Pill variant="sug">{t("kind.followup")}</Pill>
          {proposal.sourceRef?.url ? (
            <a
              href={proposal.sourceRef.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <ExternalLink size={13} aria-hidden="true" />
              {t("commitment.openThread")}
            </a>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5 md:min-w-[150px] md:flex-col">
        {p.commitmentId ? (
          <Button variant="primary" size="sm" onClick={onFollowup}>
            <Mail size={14} aria-hidden="true" />
            {t("followup.prepare")}
          </Button>
        ) : null}
        <Button size="sm" variant="quiet" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
          {t("actions.dismiss")}
        </Button>
      </div>
    </article>
  );
}
