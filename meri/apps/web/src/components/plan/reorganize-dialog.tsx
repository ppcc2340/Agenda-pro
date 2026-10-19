"use client";

import { ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { clientColorVar } from "@/lib/plan";
import type { PendingProposal, Task } from "@/lib/types";
import { useAcceptProposal, useUndo } from "./actions";
import { ReasonList } from "./reasons";

/** "Ver cómo reorganizar": the reschedule diff awaiting the user's decision (ADR 0003 §2). */
export function ReorganizeDialog({
  proposal,
  tasks,
  clients,
  timezone,
  open,
  onOpenChange,
}: {
  proposal: PendingProposal;
  tasks: Map<string, Task>;
  clients: { id: string; name: string }[];
  timezone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("plan.proposal");
  const tApp = useTranslations("app");
  const locale = useLocale();
  const { toast } = useToast();
  const accept = useAcceptProposal();
  const undo = useUndo();
  const when = (iso: string) => formatDateTime(iso, locale, timezone);
  const title = (taskId: string) => tasks.get(taskId)?.title ?? "";
  const color = (taskId: string) => clientColorVar(tasks.get(taskId)?.clientId ?? null, clients);
  const total = proposal.summary.added + proposal.summary.moved + proposal.summary.removed;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("title")}
        description={t("description", { n: total })}
        footer={
          <>
            <span className="mr-auto text-[12.5px] text-ink3">{t("note")}</span>
            <Button onClick={() => onOpenChange(false)}>{t("later")}</Button>
            <Button
              variant="primary"
              disabled={accept.isPending}
              onClick={() => {
                accept.mutate(
                  { proposalId: proposal.id },
                  {
                    onSuccess: (r) => {
                      onOpenChange(false);
                      toast(t("accepted"), {
                        undo: () => {
                          undo.mutate({ auditId: r.auditId }, { onSuccess: () => toast(t("undone")) });
                        },
                      });
                    },
                    onError: () => toast(tApp("errorBody")),
                  },
                );
              }}
            >
              {t("accept")}
            </Button>
          </>
        }
      >
        <div>
          {proposal.moved.map((m) => (
            <DiffRow key={m.blockId} color={color(m.taskId)} title={title(m.taskId)}>
              <s className="num text-ink3">{when(m.from.startsAt)}</s>
              <ChevronRight size={14} aria-hidden="true" />
              <b className="num text-ink">{when(m.to.startsAt)}</b>
              <span className="text-ink2">
                <ReasonList reasons={m.reasons} />
              </span>
            </DiffRow>
          ))}
          {proposal.added.map((a, i) => (
            <DiffRow key={`${a.taskId}-${String(i)}`} color={color(a.taskId)} title={title(a.taskId)}>
              <b className="num text-ink">{when(a.startsAt)}</b>
              <span className="rounded-full bg-ok-soft px-2 text-xs font-semibold text-ok">{t("added")}</span>
              <span className="text-ink2">
                <ReasonList reasons={a.reasons} />
              </span>
            </DiffRow>
          ))}
          {proposal.removed.map((r) => (
            <DiffRow key={r.blockId} color={color(r.taskId)} title={title(r.taskId)}>
              <s className="num text-ink3">{when(r.startsAt)}</s>
              <span className="rounded-full border border-rule px-2 text-xs font-semibold text-ink2">
                {t("removed")}
              </span>
            </DiffRow>
          ))}
          <p className="mb-1 mt-3.5 text-ink2">
            <b className="text-ink">{t("whatChanges")}</b> {t("meetingsUntouched")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiffRow({ color, title, children }: { color: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-rule py-3">
      <span
        className="mt-1.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ background: color }}
      />
      <div className="min-w-0">
        <b>{title}</b>
        <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-[13.5px] text-ink2">{children}</div>
      </div>
    </div>
  );
}
