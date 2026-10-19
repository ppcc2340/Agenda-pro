"use client";

import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation, useNotifications } from "@/lib/hooks/use-api";
import type { Notification } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";

const TEMPLATES = [
  "risk.grouped",
  "conflict.grouped",
  "plan.proposed",
  "plan.applied",
  "daily.digest",
  "proposals.new",
  "ai.paused",
] as const;
type Template = (typeof TEMPLATES)[number];
const isTemplate = (s: string): s is Template => (TEMPLATES as readonly string[]).includes(s);

/** In-app inbox for grouped alerts (F-13 AC2) and the start-of-day digest. */
export function NotificationsPanel({ initial }: { initial: Notification[] }) {
  const t = useTranslations("control.notifications");
  const format = useFormatter();
  const query = useNotifications();
  const items = query.data?.items ?? initial;
  const read = useApiMutation(
    (vars: { id: string }) =>
      clientApi<Notification>(`/v1/notifications/${vars.id}/read`, { method: "POST", json: {} }),
    [keys.notifications],
  );
  if (items.length === 0) return <p className="py-2 text-ink2">{t("empty")}</p>;
  return (
    <ul className="divide-y divide-rule">
      {items.map((n) => (
        <li key={n.id} className="flex items-start gap-3.5 py-3">
          <Pill variant={n.kind === "risk" ? "risk" : n.kind === "plan" ? "sug" : "plain"}>
            {t(`kind.${n.kind}`)}
          </Pill>
          <div className="min-w-0 flex-1">
            <span className={n.readAt ? "text-ink2" : "font-semibold"}>
              {isTemplate(n.template)
                ? t(`templates.${n.template.replace(".", "_") as "risk_grouped"}`, n.params)
                : n.title}
            </span>
            <div className="num text-[12.5px] text-ink3">
              {format.dateTime(new Date(n.createdAt), { dateStyle: "medium", timeStyle: "short" })}
            </div>
          </div>
          {n.kind === "risk" || n.kind === "plan" ? (
            <Button size="sm" asChild>
              <Link href="/hoy">{t("seeInHoy")}</Link>
            </Button>
          ) : null}
          {n.readAt ? null : (
            <Button
              size="sm"
              variant="quiet"
              disabled={read.isPending}
              onClick={() => read.mutate({ id: n.id })}
            >
              {t("markRead")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
