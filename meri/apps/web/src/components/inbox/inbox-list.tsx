"use client";

import { Check, Pencil, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDateTime, formatMinutes, isoToLocalInput, localInputToIso } from "@/lib/format";
import { idempotencyKey, keys, useApiMutation, useProposals } from "@/lib/hooks/use-api";
import type {
  CapturePayload,
  Commitment,
  CommitmentPayload,
  FollowupPayload,
  Proposal,
  Task,
} from "@/lib/types";
import { FollowupDialog, type FollowupTarget } from "@/components/commitments/followup-dialog";
import { CommitmentCard, FollowupCard } from "./commitment-card";

const HIGH = 0.85;

/** Entrada: every AI/rules proposal with confirm / edit / dismiss (F-02 AC3: suggestions are dashed until confirmed). */
export function InboxList({
  timezone,
  clients,
}: {
  timezone: string;
  clients: { id: string; name: string }[];
}) {
  const t = useTranslations("inbox");
  const tEntrada = useTranslations("entrada");
  const tApp = useTranslations("app");
  const tTasks = useTranslations("tasks");
  const locale = useLocale();
  const { toast } = useToast();
  const proposals = useProposals();
  const [editing, setEditing] = useState<string | null>(null);
  const [followup, setFollowup] = useState<FollowupTarget | null>(null);
  const invalidate = [keys.proposals, ["tasks"] as const, ["commitments"] as const, keys.audit];

  const confirm = useApiMutation(
    ({
      id,
      edits,
      commitment,
    }: {
      id: string;
      edits?: Record<string, unknown>;
      commitment?: Record<string, unknown>;
    }) =>
      clientApi<{ task: Task | null; commitment: Commitment | null }>(`/v1/proposals/${id}/confirm`, {
        method: "POST",
        json: edits ? { edits } : commitment ? { commitment } : {},
        headers: { "idempotency-key": idempotencyKey() },
      }),
    invalidate,
  );
  const dismiss = useApiMutation(
    (id: string) => clientApi<Proposal>(`/v1/proposals/${id}/dismiss`, { method: "POST", json: {} }),
    invalidate,
  );
  const batch = useApiMutation(
    (ids: string[]) =>
      clientApi<{ confirmed: string[] }>("/v1/proposals/confirm-batch", {
        method: "POST",
        json: { ids },
        headers: { "idempotency-key": idempotencyKey() },
      }),
    invalidate,
  );

  const items = proposals.data?.items ?? [];
  // Batch: high-confidence captures and explicit commitments (docs/13 confirm-batch).
  const high = items.filter(
    (p) =>
      (p.confidence ?? 0) >= HIGH &&
      (p.kind === "capture" ||
        (p.kind === "commitment" && (p.payload as unknown as CommitmentPayload).kind === "explicit")),
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-ink2">{items.length > 0 ? t("pending", { n: items.length }) : ""}</span>
        {high.length > 0 ? (
          <Button
            size="sm"
            onClick={() => {
              batch.mutate(
                high.map((p) => p.id),
                { onSuccess: (r) => toast(t("toasts.batch", { n: r.confirmed.length })) },
              );
            }}
          >
            {high.length === 1 ? t("confirmHighOne") : t("confirmHigh", { n: high.length })}
          </Button>
        ) : null}
      </div>
      {proposals.isPending ? <p className="py-6 text-ink3">{tApp("loading")}</p> : null}
      {proposals.isError ? (
        <p role="alert" className="py-6 text-risk">
          {tApp("errorBody")}
        </p>
      ) : null}
      <div className="border-t border-rule">
        {proposals.data && items.length === 0 ? (
          <EmptyState title={tEntrada("emptyTitle")} body={tEntrada("emptyBody")} />
        ) : null}
        {items.map((p) => {
          if (p.kind === "commitment") {
            return (
              <CommitmentCard
                key={p.id}
                proposal={p}
                timezone={timezone}
                clients={clients}
                busy={confirm.isPending}
                onConfirm={(edits) =>
                  confirm.mutate(
                    { id: p.id, commitment: edits ?? {} },
                    { onSuccess: () => toast(t("toasts.commitmentConfirmed")) },
                  )
                }
                onDismiss={() => dismiss.mutate(p.id, { onSuccess: () => toast(t("toasts.dismissed")) })}
              />
            );
          }
          if (p.kind === "followup") {
            const fp = p.payload as unknown as FollowupPayload;
            return (
              <FollowupCard
                key={p.id}
                proposal={p}
                timezone={timezone}
                clients={clients}
                busy={confirm.isPending}
                onWaitingTask={() =>
                  confirm.mutate({ id: p.id }, { onSuccess: () => toast(t("toasts.waitingTask")) })
                }
                onFollowup={() =>
                  fp.commitmentId &&
                  setFollowup({
                    commitmentId: fp.commitmentId,
                    counterpartyName: fp.counterpartyName,
                    counterpartyEmail: fp.counterpartyEmail,
                    proposalId: p.id,
                  })
                }
                onDismiss={() => dismiss.mutate(p.id, { onSuccess: () => toast(t("toasts.dismissed")) })}
              />
            );
          }
          if (p.kind === "reschedule") {
            return (
              <RescheduleCard
                key={p.id}
                proposal={p}
                onDismiss={() => dismiss.mutate(p.id, { onSuccess: () => toast(t("toasts.dismissed")) })}
              />
            );
          }
          const payload = p.payload as unknown as CapturePayload;
          const isEditing = editing === p.id;
          return (
            <article
              key={p.id}
              className="flex flex-col gap-3 border-b border-rule border-l-[3px] border-l-dashed border-l-sug bg-[linear-gradient(90deg,var(--sug-soft),transparent_30%)] px-4 py-4 md:flex-row md:items-start md:gap-4"
            >
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <form
                    id={`edit-${p.id}`}
                    className="grid gap-2 sm:grid-cols-[2fr_1fr]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const str = (k: string) => {
                        const v = fd.get(k);
                        return typeof v === "string" ? v.trim() : "";
                      };
                      const title = str("title");
                      const due = str("dueAt");
                      confirm.mutate(
                        {
                          id: p.id,
                          edits: {
                            title: title || payload.title,
                            dueAt: due ? localInputToIso(due, timezone) : null,
                          },
                        },
                        {
                          onSuccess: () => {
                            setEditing(null);
                            toast(t("toasts.confirmed"));
                          },
                        },
                      );
                    }}
                  >
                    <input
                      name="title"
                      autoFocus
                      defaultValue={payload.title}
                      aria-label={t("editAction")}
                      className="rounded-lg border border-rule bg-raised px-2.5 py-1.5"
                    />
                    <input
                      name="dueAt"
                      type="datetime-local"
                      defaultValue={payload.dueAt ? isoToLocalInput(payload.dueAt, timezone) : ""}
                      aria-label={t("editDate")}
                      className="num rounded-lg border border-rule bg-raised px-2.5 py-1.5"
                    />
                  </form>
                ) : (
                  <div className="text-[15.5px] font-semibold">{payload.title}</div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
                  {payload.clientName ? <span>{payload.clientName}</span> : null}
                  <span className="num">
                    {payload.dueAt
                      ? t("forDate", { date: formatDateTime(payload.dueAt, locale, timezone) })
                      : t("noDate")}
                  </span>
                  {payload.estimateMinutes ? (
                    <span className="num">
                      {formatMinutes(payload.estimateMinutes, (k, v) => tTasks(k, v))}
                    </span>
                  ) : null}
                  <Pill variant="sug">{t(`kind.${p.kind}`)}</Pill>
                  {p.confidence !== null ? (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="inline-block h-1.5 w-11 overflow-hidden rounded-full bg-rule">
                        <b
                          className="block h-full bg-sea"
                          style={{ width: `${String(Math.round(p.confidence * 100))}%` }}
                        />
                      </span>
                      <span className="num">{Math.round(p.confidence * 100)} %</span>
                    </span>
                  ) : null}
                  <span className="text-ink3">{t(`source.${payload.source}`)}</span>
                </div>
                <p className="mt-2 border-l-2 border-rule pl-3 text-[13px] italic text-ink2">
                  {t("quote", { text: payload.text })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5 md:min-w-[150px] md:flex-col">
                {isEditing ? (
                  <>
                    <Button variant="primary" size="sm" type="submit" form={`edit-${p.id}`}>
                      {t("actions.saveConfirm")}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(null)}>
                      {t("actions.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        confirm.mutate({ id: p.id }, { onSuccess: () => toast(t("toasts.confirmed")) })
                      }
                    >
                      <Check size={14} aria-hidden="true" />
                      {t("actions.confirm")}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(p.id)}>
                      <Pencil size={14} aria-hidden="true" />
                      {t("actions.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => dismiss.mutate(p.id, { onSuccess: () => toast(t("toasts.dismissed")) })}
                    >
                      <X size={14} aria-hidden="true" />
                      {t("actions.dismiss")}
                    </Button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <FollowupDialog target={followup} onClose={() => setFollowup(null)} />
    </div>
  );
}

/** Reschedule proposals (ADR 0003) live in Hoy's "¿Qué podría salir mal?"; here only a summary and a link. */
function RescheduleCard({ proposal, onDismiss }: { proposal: Proposal; onDismiss: () => void }) {
  const t = useTranslations("inbox");
  const summary = (proposal.payload as { summary?: { added: number; removed: number; moved: number } })
    .summary ?? {
    added: 0,
    removed: 0,
    moved: 0,
  };
  return (
    <article className="flex flex-col gap-3 border-b border-rule border-l-[3px] border-l-dashed border-l-sug bg-[linear-gradient(90deg,var(--sug-soft),transparent_30%)] px-4 py-4 md:flex-row md:items-start md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t("reschedule.title")}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
          <span className="num">{t("reschedule.summary", summary)}</span>
          <Pill variant="sug">{t("kind.reschedule")}</Pill>
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5 md:min-w-[150px] md:flex-col">
        <Button variant="primary" size="sm" asChild>
          <Link href="/hoy">{t("reschedule.review")}</Link>
        </Button>
        <Button size="sm" variant="quiet" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
          {t("actions.dismiss")}
        </Button>
      </div>
    </article>
  );
}
