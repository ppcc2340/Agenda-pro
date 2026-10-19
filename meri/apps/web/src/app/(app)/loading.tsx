import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("app");
  return (
    <p className="py-8 text-ink3" aria-live="polite">
      {t("loading")}
    </p>
  );
}
