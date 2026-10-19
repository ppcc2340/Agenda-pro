"use client";

import { Moon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

const KEY = "meri.theme";

/** Inline script run before paint so the theme never flashes (reads localStorage). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

function isDarkNow(): boolean {
  const root = document.documentElement;
  return (
    root.dataset.theme === "dark" ||
    (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("app");
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(isDarkNow());
  }, []);
  const toggle = useCallback(() => {
    const next = isDarkNow() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(next === "dark");
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: theme just does not persist */
    }
  }, []);
  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      aria-pressed={dark}
      aria-label={t("themeDark")}
    >
      <Moon size={16} aria-hidden="true" />
      <span>{t("theme")}</span>
    </button>
  );
}
