import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function NotFound() {
  const t = await getTranslations("app");
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <h1 className="text-2xl">{t("errorTitle")}</h1>
        <p className="mt-2 text-ink2">{t("errorBody")}</p>
        <Link href="/hoy" className="mt-4 inline-block underline">
          {t("retry")}
        </Link>
      </div>
    </main>
  );
}
