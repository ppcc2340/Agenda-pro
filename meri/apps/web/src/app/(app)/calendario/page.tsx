import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { CalendarView } from "@/components/plan/calendar-view";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { IntegrationAccount } from "@/lib/types";
import { apiFetch } from "@/server/api";
import { getServerConfig } from "@/server/config";

export default async function CalendarioPage() {
  const t = await getTranslations("calendario");
  const nav = await getTranslations("nav");
  const [prefs, clients, integrations] = await Promise.all([
    apiFetch<{ timezone: string; workStart: string; workEnd: string }>("/v1/preferences"),
    apiFetch<{ items: { id: string; name: string; color: string | null }[] }>("/v1/clients").catch(() => ({ items: [] })),
    apiFetch<{ items: IntegrationAccount[] }>("/v1/integrations").catch(() => ({ items: [] })),
  ]);
  const demoNow = getServerConfig().env.DEMO_NOW;
  const connected = integrations.items.some((a) => a.provider === "google" && a.status !== "revoked");
  return (
    <>
      <PageHeader title={nav("calendario")} subtitle={t("subtitle")} action={<CaptureButton />} />
      {!connected ? (
        <EmptyState
          title={t("emptyTitle")}
          body={t("emptyBody")}
          action={
            <Button asChild>
              <Link href="/control">{t("connect")}</Link>
            </Button>
          }
        />
      ) : null}
      <CalendarView
        timezone={prefs.timezone}
        workStart={prefs.workStart}
        workEnd={prefs.workEnd}
        clients={clients.items}
        now={demoNow ? new Date(demoNow).toISOString() : undefined}
      />
    </>
  );
}
