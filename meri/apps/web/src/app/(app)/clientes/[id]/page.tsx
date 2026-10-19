import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ClientDetail } from "@/components/clients/client-detail";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import type { Client } from "@/lib/types";
import { apiFetch, ApiRequestError } from "@/server/api";
import { getServerConfig } from "@/server/config";

/** P3-08 /clientes/[id]: the client's view (timeline, risks, month hours, briefing). */
export default async function ClientePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ briefing?: string }>;
}) {
  const { id } = await params;
  const { briefing } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("clientDetail");
  const [client, prefs] = await Promise.all([
    apiFetch<Client>(`/v1/clients/${id}?stats=month`).catch((e: unknown) => {
      if (e instanceof ApiRequestError && e.status === 404) return null;
      throw e;
    }),
    apiFetch<{ timezone: string }>("/v1/preferences"),
  ]);
  if (!client) notFound();
  const demoNow = getServerConfig().env.DEMO_NOW;
  return (
    <>
      <PageHeader title={client.name} subtitle={t("subtitle")} action={<CaptureButton />} />
      <ClientDetail
        client={client}
        timezone={prefs.timezone}
        now={demoNow ? new Date(demoNow).toISOString() : undefined}
        openBriefing={briefing === "1"}
      />
    </>
  );
}
