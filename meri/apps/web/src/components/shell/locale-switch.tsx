"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, LOCALES } from "@/i18n/locale";

export function LocaleSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("app");
  const router = useRouter();
  return (
    <label className={className}>
      <span className="sr-only">{t("language")}</span>
      <select
        aria-label={t("language")}
        value={locale}
        onChange={(e) => {
          document.cookie = `${LOCALE_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
        className="rounded-md border border-rule bg-raised px-2 py-1 text-xs text-ink"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {l.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}
