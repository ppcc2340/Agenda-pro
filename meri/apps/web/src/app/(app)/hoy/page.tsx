import { getFormatter, getLocale } from "next-intl/server";
import { HoyView } from "@/components/plan/hoy-view";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import type { Task } from "@/lib/types";
import { apiFetch } from "@/server/api";
import { getServerConfig } from "@/server/config";

export default async function HoyPage() {
  const format = await getFormatter();
  const locale = await getLocale();
  const [tasks, prefs, clients, integrations] = await Promise.all([
    apiFetch<{ items: Task[] }>("/v1/tasks?limit=200"),
    apiFetch<{ timezone: string; workStart: string; workEnd: string }>("/v1/preferences"),
    apiFetch<{ items: { id: string; name: string; color: string | null }[] }>("/v1/clients").catch(() => ({ items: [] })),
    apiFetch<{ items: { scopes: string[] }[] }>("/v1/integrations").catch(() => ({ items: [] })),
  ]);
  const gmailConnected = integrations.items.some((i) => i.scopes.some((s) => s.includes("gmail.readonly")));
  const demoNow = getServerConfig().env.DEMO_NOW;
  const now = demoNow ? new Date(demoNow) : new Date();
  const pending = tasks.items.filter((x) => x.status === "pending" || x.status === "at_risk");
  const title = format.dateTime(now, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: prefs.timezone,
  });
  return (
    <>
      <PageHeader
        title={title.charAt(0).toLocaleUpperCase(locale) + title.slice(1)}
        action={<CaptureButton />}
      />
      <HoyView
        timezone={prefs.timezone}
        workStart={prefs.workStart}
        workEnd={prefs.workEnd}
        clients={clients.items}
        now={demoNow ? now.toISOString() : undefined}
        pendingTasks={pending}
        gmailConnected={gmailConnected}
      />
    </>
  );
}
