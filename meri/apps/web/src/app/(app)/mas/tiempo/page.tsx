import { getTranslations } from "next-intl/server";
import { MasHeader } from "@/components/shell/mas-header";
import { TimeReview } from "@/components/time/time-review";
import { apiFetch } from "@/server/api";

export default async function MasTiempoPage() {
  const t = await getTranslations("mas");
  const [clients, prefs] = await Promise.all([
    apiFetch<{ items: { id: string; name: string; color: string | null }[] }>("/v1/clients"),
    apiFetch<{ timezone: string }>("/v1/preferences"),
  ]);
  return (
    <>
      <MasHeader title={t("time")} subtitle={t("timeSubtitle")} />
      <TimeReview clients={clients.items} timezone={prefs.timezone} />
    </>
  );
}
