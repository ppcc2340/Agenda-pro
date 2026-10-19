"use client";

import { Undo2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useUndo } from "@/components/plan/actions";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";

export interface ActivityItem {
  id: string;
  actor: "user" | "system" | "ai";
  action: string;
  createdAt: string;
  undoneAt: string | null;
  undoOfAuditId: string | null;
}

const ACTION_KEYS = [
  "onboarding_completed",
  "preferences_updated",
  "task_created",
  "task_updated",
  "task_completed",
  "task_deleted",
  "task_dependencies_updated",
  "capture_created",
  "proposal_dismissed",
  "plan_generated",
  "plan_accepted",
  "block_pinned",
  "block_completed",
  "integration_connected",
  "integration_disconnected",
  "integration_needs_reauth",
] as const;
type ActionKey = (typeof ACTION_KEYS)[number];
const toKey = (action: string): ActionKey | null => {
  const k = action.replace(/\./g, "_");
  return (ACTION_KEYS as readonly string[]).includes(k) ? (k as ActionKey) : null;
};

/** Actions that can be compensated through POST /v1/audit/:id/undo (ADR 0003 §4). */
export const UNDOABLE = new Set([
  "plan.generated",
  "plan.accepted",
  "task.completed",
  "task.created",
  "block.pinned",
  "block.completed",
]);

/** Activity feed (F-14): every automated action is visible and, when possible, undoable. */
export function ActivityList({ items }: { items: ActivityItem[] }) {
  const t = useTranslations("control.activity");
  const tApp = useTranslations("app");
  const format = useFormatter();
  const { toast } = useToast();
  const undo = useUndo();
  if (items.length === 0) return <p className="py-2 text-ink2">{t("empty")}</p>;
  return (
    <ul className="divide-y divide-rule">
      {items.map((item) => {
        const key = toKey(item.undoOfAuditId ? item.action.replace(/\.undone$/, "") : item.action);
        const text = key ? t(`actions.${key}`) : t("actions.other", { action: item.action });
        return (
          <li key={item.id} className="flex items-start gap-3.5 py-3">
            <Pill variant={item.actor === "ai" ? "sug" : item.actor === "user" ? "ok" : "plain"}>
              {t(`actor.${item.actor}`)}
            </Pill>
            <div className="min-w-0 flex-1">
              {item.undoOfAuditId ? t("undoneOf", { text }) : text}
              <div className="num text-[12.5px] text-ink3">
                {format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" })}
              </div>
            </div>
            {item.undoneAt ? (
              <span className="text-ink3">{t("undone")}</span>
            ) : UNDOABLE.has(item.action) ? (
              <Button
                size="sm"
                disabled={undo.isPending}
                onClick={() => {
                  undo.mutate(
                    { auditId: item.id },
                    { onSuccess: () => toast(t("undoDone")), onError: () => toast(tApp("errorBody")) },
                  );
                }}
              >
                <Undo2 size={14} aria-hidden="true" />
                {t("undo")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
