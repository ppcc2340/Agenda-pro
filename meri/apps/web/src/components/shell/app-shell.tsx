"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type * as React from "react";
import { usePalette } from "@/components/capture/palette";
import { cn } from "@/lib/cn";
import { AREAS, MOBILE_TABS, type AreaKey } from "./areas";
import { LocaleSwitch } from "./locale-switch";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

export interface ShellBadges {
  entrada?: number;
  proyectos?: number;
}

/**
 * Desktop: dark rail with the five areas (demo/desktop.html). Mobile (< 768px): bottom tab bar with the five tabs
 * (demo/mobile.html). The content area is shared.
 */
export function AppShell({
  children,
  badges = {},
  footer,
}: {
  children: React.ReactNode;
  badges?: ShellBadges;
  footer?: React.ReactNode;
}) {
  const t = useTranslations("nav");
  const tApp = useTranslations("app");
  const pathname = usePathname();
  const isActive = (href: string) => {
    const path = href.split("?")[0] ?? href;
    return pathname === path || pathname.startsWith(`${path}/`);
  };
  const badgeFor = (key: AreaKey): number | undefined =>
    key === "entrada" ? badges.entrada : key === "proyectos" ? badges.proyectos : undefined;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr] lg:grid-cols-[240px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2"
      >
        {tApp("skipToContent")}
      </a>
      <aside className="hidden bg-rail px-3.5 py-5 text-rail-ink md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2 pb-5 font-head text-2xl font-bold tracking-tight text-white">
          <Logo size={30} />
          <span>{tApp("name")}</span>
        </div>
        <nav className="flex flex-col gap-0.5" aria-label={t("areas")}>
          {AREAS.map(({ key, href, icon: Icon }) => {
            const active = isActive(href);
            const badge = badgeFor(key);
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 font-medium text-rail-ink hover:bg-white/5",
                  active &&
                    "bg-[rgba(92,201,207,0.14)] text-white before:absolute before:-left-3.5 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r before:bg-[#5CC9CF]",
                )}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{t(key)}</span>
                {badge ? (
                  <em
                    className={cn(
                      "ml-auto min-w-5 rounded-full px-1.5 text-center text-xs font-bold not-italic",
                      key === "proyectos" ? "bg-[#F0707F] text-[#2b0b10]" : "bg-[#5CC9CF] text-[#06242A]",
                    )}
                  >
                    {badge}
                  </em>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-2.5 border-t border-white/10 px-2 pt-3 text-[12.5px] text-rail-dim">
          <ThemeToggle className="flex items-center gap-2 bg-transparent p-0 text-rail-ink" />
          <LocaleSwitch />
          {footer}
        </div>
      </aside>
      <main id="main" className="overflow-auto px-4 pb-24 pt-5 md:px-11 md:pb-16 md:pt-6">
        <div className="mx-auto max-w-[1160px]">{children}</div>
      </main>
      <nav
        aria-label={t("areas")}
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-rule bg-raised px-1 pb-[calc(8px+env(safe-area-inset-bottom,0px))] pt-1.5 md:hidden"
      >
        {MOBILE_TABS.map(({ key, href, icon: Icon }) => {
          // «Más» covers its own pages and the control centre reached from them.
          const active = key === "mas" ? isActive("/mas") || isActive("/control") : isActive(href);
          const badge =
            key === "entrada" ? badges.entrada : key === "compromisos" ? badges.proyectos : undefined;
          return (
            <Link
              key={key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-0.5 py-1.5 text-[11.5px] font-semibold text-ink3",
                active && "text-sea",
              )}
            >
              <Icon size={22} aria-hidden="true" />
              <span>{t(`mobile.${key}`)}</span>
              {badge ? (
                <em
                  className={cn(
                    "absolute left-[calc(50%+7px)] top-0 min-w-[18px] rounded-full px-1.5 text-[11px] font-bold not-italic",
                    key === "compromisos" ? "bg-risk text-white" : "bg-sea text-on-sea",
                  )}
                >
                  {badge}
                </em>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-5">
      <div>
        {/* Focusable by script only: where focus goes when a card the person was using disappears. */}
        <h1 tabIndex={-1} className="text-[28px] leading-[1.1] outline-none md:text-[34px]">
          {title}
        </h1>
        {subtitle ? <p className="mt-2 max-w-[60ch] text-[15.5px] text-ink2">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CaptureButton() {
  const t = useTranslations("nav");
  const palette = usePalette();
  return (
    <button
      type="button"
      onClick={palette.open}
      className="hidden min-w-[260px] items-center gap-2.5 rounded-[11px] border border-rule bg-raised px-3.5 py-2 text-ink2 hover:border-ink3 md:flex"
      aria-keyshortcuts="Control+K Meta+K"
    >
      <Search size={16} aria-hidden="true" />
      <span>{t("capture")}</span>
      <kbd className="ml-auto rounded-md border border-rule bg-panel px-1.5 text-[11.5px] font-semibold text-ink3">
        {t("captureShortcut")}
      </kbd>
    </button>
  );
}
