"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("app");
  return (
    <div role="alert" className="max-w-[52ch] py-8">
      <h2 className="text-lg">{t("errorTitle")}</h2>
      <p className="mt-1 text-ink2">{t("errorBody")}</p>
      <Button className="mt-4" onClick={reset}>
        {t("retry")}
      </Button>
    </div>
  );
}
