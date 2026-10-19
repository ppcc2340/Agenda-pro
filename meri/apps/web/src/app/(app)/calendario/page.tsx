import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default async function CalendarioPage() {
  const t = await getTranslations("calendario");
  const nav = await getTranslations("nav");
  return (
    <>
      <PageHeader title={nav("calendario")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <EmptyState
        title={t("emptyTitle")}
        body={t("emptyBody")}
        action={
          <Button asChild>
            <Link href="/control">{nav("control")}</Link>
          </Button>
        }
      />
    </>
  );
}
