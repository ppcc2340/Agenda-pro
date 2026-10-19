import { getFormatter, getTranslations } from "next-intl/server";
import { Pill } from "@/components/ui/pill";

export interface ActivityItem {
  id: string;
  actor: "user" | "system" | "ai";
  action: string;
  createdAt: string;
  undoneAt: string | null;
}

/** Audit action -> message key (next-intl keys cannot contain dots). */
const ACTION_KEYS: Record<string, "onboarding_completed" | "preferences_updated"> = {
  "onboarding.completed": "onboarding_completed",
  "preferences.updated": "preferences_updated",
};

/** Activity feed (F-14). Each automated action is visible; undo arrives with the actions that support it. */
export async function ActivityList({ items }: { items: ActivityItem[]; locale: string }) {
  const t = await getTranslations("control.activity");
  const format = await getFormatter();
  if (items.length === 0) return <p className="py-2 text-ink2">{t("empty")}</p>;
  return (
    <ul className="divide-y divide-rule">
      {items.map((item) => {
        const key = ACTION_KEYS[item.action];
        return (
          <li key={item.id} className="flex items-start gap-3.5 py-3">
            <Pill variant={item.actor === "ai" ? "sug" : item.actor === "user" ? "ok" : "plain"}>
              {t(`actor.${item.actor}`)}
            </Pill>
            <div className="min-w-0 flex-1">
              {key ? t(`actions.${key}`) : t("actions.other", { action: item.action })}
              <div className="num text-[12.5px] text-ink3">
                {format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" })}
              </div>
            </div>
            {item.undoneAt ? <span className="text-ink3">{t("undone")}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
