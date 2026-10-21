"use client";

import { Undo2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useUndo } from "@/components/plan/actions";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";

export interface ActivityItem {
  id: string;
  actor: "user" | "system" | "ai";
  action: string;
  createdAt: string;
  undoneAt: string | null;
  undoOfAuditId: string | null;
  /** Title or name of the entity (task, client, asunto, commitment), when it still exists. */
  entityLabel?: string | null;
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
  "commitment_autoconfirmed",
  "commitment_confirmed",
  "commitment_dismissed",
  "commitment_fulfilled",
  "followup_reminder",
  "followup_draft_saved",
  "task_waiting_created",
  "commitment_updated",
  "followups_muted",
  "followups_unmuted",
  "mail_exclusion_added",
  "mail_exclusion_removed",
  "integration_paused",
  "integration_resumed",
  "time_approved",
  "time_rejected",
  "time_updated",
  "event_client_assigned",
  "briefing_generated",
  "client_created",
  "client_updated",
  "client_archived",
  "client_restored",
  "client_deleted",
  "project_created",
  "project_updated",
  "proposal_confirmed",
  "proposal_edited",
  "agreements_recorded",
  "preferences_autonomy_changed",
  "account_exported",
  "account_deleted",
  "account_sessions_revoked",
  "security_keys_rotated",
  "mail_retention_applied",
  "ai_review_sampled",
  "notifications_email_unsubscribed",
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
  "commitment.autoconfirmed",
  "time.approved",
]);

/**
 * Activity feed (F-14, P5-05): every automated action is visible, names what it touched and, when possible, is
 * undoable; older entries load page by page.
 */
export function ActivityList({
  items: initial,
  nextCursor: initialCursor = null,
}: {
  items: ActivityItem[];
  nextCursor?: string | null;
}) {
  const t = useTranslations("control.activity");
  const tApp = useTranslations("app");
  const format = useFormatter();
  const { toast } = useToast();
  const undo = useUndo();
  const [more, setMore] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const items = [...initial, ...more.filter((m) => !initial.some((i) => i.id === m.id))];
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await clientApi<{ items: ActivityItem[]; nextCursor: string | null }>(
        `/v1/audit?limit=20&cursor=${encodeURIComponent(cursor)}`,
      );
      setMore((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      toast(tApp("errorBody"));
    } finally {
      setLoading(false);
    }
  };
  if (items.length === 0) return <p className="py-2 text-ink2">{t("empty")}</p>;
  return (
    <>
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
                {item.entityLabel ? (
                  <span className="block truncate text-ink2" title={item.entityLabel}>
                    {item.entityLabel}
                  </span>
                ) : null}
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
      {cursor ? (
        <Button
          size="sm"
          className="mt-2"
          disabled={loading}
          aria-busy={loading}
          onClick={() => void loadMore()}
        >
          {loading ? t("loadingMore") : t("more")}
        </Button>
      ) : null}
    </>
  );
}
