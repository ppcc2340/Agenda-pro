import { getTranslations } from "next-intl/server";
import { ActivityList } from "@/components/control/activity-list";
import { NotificationsPanel } from "@/components/control/notifications-panel";
import { MasHeader } from "@/components/shell/mas-header";
import { Panel } from "@/components/ui/section";
import type { Notification } from "@/lib/types";
import { apiFetch } from "@/server/api";

interface AuditPage {
  items: {
    id: string;
    actor: "user" | "system" | "ai";
    action: string;
    createdAt: string;
    undoneAt: string | null;
    undoOfAuditId: string | null;
  }[];
}

export default async function MasActividadPage() {
  const t = await getTranslations("mas");
  const tc = await getTranslations("control");
  const [audit, notifications] = await Promise.all([
    apiFetch<AuditPage>("/v1/audit?limit=20"),
    apiFetch<{ items: Notification[] }>("/v1/notifications?limit=20").catch(() => ({ items: [] })),
  ]);
  return (
    <>
      <MasHeader title={t("activity")} subtitle={t("activityDesc")} />
      <Panel title={tc("activity.title")} desc={tc("activity.desc")}>
        <ActivityList items={audit.items} />
      </Panel>
      <Panel title={tc("notifications.title")} desc={tc("notifications.desc")}>
        <NotificationsPanel initial={notifications.items} />
      </Panel>
    </>
  );
}
