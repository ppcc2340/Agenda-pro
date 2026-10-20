import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { Logo } from "@/components/shell/logo";
import { apiFetch, getMe } from "@/server/api";

export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) redirect("/api/session/expired");
  const prefs = await apiFetch<{
    timezone: string;
    workStart: string;
    workEnd: string;
    workDays: number[];
    contingencyPct: number;
    vertical: "legal" | "consulting" | "generic";
  }>("/v1/preferences");
  const t = await getTranslations("onboarding");
  const tApp = await getTranslations("app");
  return (
    <main className="mx-auto max-w-[640px] px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
        <Logo size={30} />
        <span>{tApp("name")}</span>
      </div>
      <h1 className="text-[28px] leading-[1.1]">{t("title")}</h1>
      <p className="mt-2 text-ink2">{t("body")}</p>
      <OnboardingForm initial={{ ...prefs, timezone: prefs.timezone === "UTC" ? "" : prefs.timezone }} />
    </main>
  );
}
