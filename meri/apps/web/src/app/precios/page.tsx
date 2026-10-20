import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { PlanComparator } from "@/components/billing/plan-comparator";
import { Logo } from "@/components/shell/logo";

export async function generateMetadata() {
  const t = await getTranslations("pricing");
  return { title: t("title") };
}

/** D-067: public pricing page (no session) with the comparator from the core catalogue. */
export default async function PricingPage() {
  const t = await getTranslations("pricing");
  const tApp = await getTranslations("app");
  return (
    <main className="mx-auto max-w-[920px] px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
        <Logo size={30} />
        <span>{tApp("name")}</span>
      </Link>
      <h1 className="text-[28px] leading-[1.1] md:text-[34px]">{t("title")}</h1>
      <p className="mt-2 max-w-[60ch] text-[15.5px] text-ink2">{t("subtitle")}</p>
      <p className="mt-3 rounded-lg border border-rule bg-raised px-3 py-2 text-ink2">
        {t("testNote")}
      </p>
      <div className="mt-6">
        <PlanComparator ctaHref="/login" />
      </div>
      <p className="mt-8 text-[13.5px] text-ink2">
        <Link href="/privacy" className="underline">
          {t("privacy")}
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="underline">
          {t("terms")}
        </Link>
      </p>
    </main>
  );
}
