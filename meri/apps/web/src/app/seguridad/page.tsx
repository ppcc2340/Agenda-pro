import { getTranslations } from "next-intl/server";
import { SecurityPage } from "@/components/security-page";

export async function generateMetadata() {
  const t = await getTranslations("security");
  return { title: t("title") };
}

export default function SeguridadPage() {
  return <SecurityPage />;
}
