import { getTranslations } from "next-intl/server";
import { ClientList } from "@/components/clients/client-list";
import { MasHeader } from "@/components/shell/mas-header";

export default async function MasClientesPage() {
  const t = await getTranslations("mas");
  return (
    <>
      <MasHeader title={t("clients")} subtitle={t("clientsDesc")} />
      <ClientList />
    </>
  );
}
