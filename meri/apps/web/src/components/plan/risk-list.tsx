"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { clientColorVar, riskRows } from "@/lib/plan";
import type { Plan, Task } from "@/lib/types";
import { useReplan } from "./actions";
import { ReorganizeDialog } from "./reorganize-dialog";

const RISK_CODES = ["LOW_SLACK", "BLOCKED_DEPENDENCY", "NO_CAPACITY"] as const;
const CONFLICT_CODES = [
  "CIRCULAR_DEPENDENCY",
  "OVERLOAD",
  "DEADLINE_INFEASIBLE",
  "NO_CAPACITY",
  "DEPENDENCY_AFTER_DEADLINE",
] as const;
const ALTERNATIVES = [
  "move_other_task",
  "split_task",
  "extend_deadline",
  "delegate",
  "reduce_scope",
] as const;
type RiskCode = (typeof RISK_CODES)[number];
type ConflictCode = (typeof CONFLICT_CODES)[number];
type Alternative = (typeof ALTERNATIVES)[number];
const isRisk = (c: string): c is RiskCode => (RISK_CODES as readonly string[]).includes(c);
const isConflict = (c: string): c is ConflictCode => (CONFLICT_CODES as readonly string[]).includes(c);
const isAlt = (c: string): c is Alternative => (ALTERNATIVES as readonly string[]).includes(c);

/** "¿Qué podría salir mal?" (F-13): rule-computed risks and conflicts with alternatives, never silent moves. */
export function RiskList({
  plan,
  clients,
  timezone,
}: {
  plan: Plan;
  clients: { id: string; name: string }[];
  timezone: string;
}) {
  const t = useTranslations("plan.risks");
  const tHoy = useTranslations("hoy");
  const { toast } = useToast();
  const replan = useReplan();
  const [open, setOpen] = useState(false);
  const rows = riskRows(plan);
  const tasks = new Map<string, Task>(plan.tasks.map((x) => [x.id, x]));
  if (rows.length === 0) return <EmptyState title={tHoy("emptyRisksTitle")} body={tHoy("emptyRisksBody")} />;
  return (
    <div>
      <ul className="divide-y divide-rule border-t border-rule">
        {rows.map((r) => (
          <li
            key={r.taskId}
            className="-ml-0.5 flex flex-col gap-2 border-l-[3px] border-risk py-3 pl-3.5 md:flex-row md:items-start"
          >
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{r.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                {r.clientId ? (
                  <span className="inline-flex items-center gap-1.5">
                    <i
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: clientColorVar(r.clientId, clients) }}
                    />
                    {clients.find((c) => c.id === r.clientId)?.name ?? ""}
                  </span>
                ) : null}
                <span>
                  {r.kind === "risk" && isRisk(r.code)
                    ? t(`cause.${r.code}`, { hours: Math.max(0, Math.round((r.slackHours ?? 0) * 10) / 10) })
                    : isConflict(r.code)
                      ? t(`conflict.${r.code}`)
                      : r.code}
                </span>
              </div>
              {r.alternatives.length > 0 ? (
                <div className="mt-1 text-[13px] text-ink3">
                  {t("alternatives")}{" "}
                  {r.alternatives
                    .filter(isAlt)
                    .map((a) => t(`alternative.${a}`))
                    .join(" · ")}
                </div>
              ) : null}
            </div>
            <div className="flex-shrink-0">
              {plan.pendingProposal ? (
                <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                  {t("reorganize")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={replan.isPending}
                  onClick={() => {
                    replan.mutate(undefined, {
                      onSuccess: (r) =>
                        toast(r.outcome === "proposed" ? t("toasts.proposed") : t("toasts.replanned")),
                    });
                  }}
                >
                  {t("replan")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {plan.pendingProposal ? (
        <ReorganizeDialog
          proposal={plan.pendingProposal}
          tasks={tasks}
          clients={clients}
          timezone={timezone}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}
