import { getTranslations } from "next-intl/server";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/ui/empty-state";

export default async function EntradaPage() {
  const t = await getTranslations("entrada");
  const nav = await getTranslations("nav");
  return (
    <>
      <PageHeader title={nav("entrada")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <div className="border-t border-rule">
        <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
      </div>
    </>
  );
}
