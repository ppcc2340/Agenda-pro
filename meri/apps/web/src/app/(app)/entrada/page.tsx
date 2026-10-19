import { getTranslations } from "next-intl/server";
import { InboxList } from "@/components/inbox/inbox-list";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { apiFetch } from "@/server/api";

export default async function EntradaPage() {
  const t = await getTranslations("entrada");
  const nav = await getTranslations("nav");
  const [prefs, clients] = await Promise.all([
    apiFetch<{ timezone: string }>("/v1/preferences"),
    apiFetch<{ items: { id: string; name: string }[] }>("/v1/clients").catch(() => ({ items: [] })),
  ]);
  return (
    <>
      <PageHeader title={nav("entrada")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <InboxList timezone={prefs.timezone} clients={clients.items} />
    </>
  );
}
