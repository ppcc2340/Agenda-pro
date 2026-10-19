"use client";

import { Moon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback } from "react";

const KEY = "meri.theme";

/** Inline script run before paint so the theme never flashes (reads localStorage). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("app");
  const toggle = useCallback(() => {
    const root = document.documentElement;
    const dark =
      root.dataset.theme === "dark" ||
      (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: theme just does not persist */
    }
  }, []);
  return (
    <button type="button" onClick={toggle} className={className}>
      <Moon size={16} aria-hidden="true" />
      <span>{t("theme")}</span>
    </button>
  );
}
