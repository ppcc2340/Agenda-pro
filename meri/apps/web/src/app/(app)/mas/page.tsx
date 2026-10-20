import { Activity, ChevronRight, Clock, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { PageHeader } from "@/components/shell/app-shell";
import type { TimeWeek } from "@/lib/types";
import { apiFetch } from "@/server/api";

/** «Más» (demo/mobile.html): Tiempo, Clientes y briefings, Actividad, Autonomía y privacidad. */
export default async function MasPage() {
  const t = await getTranslations("mas");
  const week = await apiFetch<TimeWeek>("/v1/time-entries").catch(() => null);
  const suggested = week?.items.filter((i) => i.status === "suggested").length ?? 0;
  const rows: { href: string; icon: LucideIcon; label: string; desc: string }[] = [
    { href: "/mas/tiempo", icon: Clock, label: t("time"), desc: week ? t("timeDesc", { n: suggested }) : t("timeSubtitle") },
    { href: "/mas/clientes", icon: Users, label: t("clients"), desc: t("clientsDesc") },
    { href: "/mas/actividad", icon: Activity, label: t("activity"), desc: t("activityDesc") },
    { href: "/mas/ajustes", icon: ShieldCheck, label: t("settings"), desc: t("settingsDesc") },
  ];
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <ul className="divide-y divide-rule rounded-2xl border border-rule bg-raised" aria-label={t("title")}>
        {rows.map(({ href, icon: Icon, label, desc }) => (
          <li key={href}>
            <Link href={href} className="flex items-center gap-3.5 px-4 py-3.5">
              <Icon size={20} aria-hidden="true" className="shrink-0 text-sea" />
              <span className="min-w-0 flex-1">
                <b className="block">{label}</b>
                <small className="block text-[13px] text-ink2">{desc}</small>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="text-ink3" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
