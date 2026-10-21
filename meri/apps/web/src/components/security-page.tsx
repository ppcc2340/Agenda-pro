import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Logo } from "@/components/shell/logo";

export const SECURITY_SECTIONS = [
  "read",
  "store",
  "never",
  "ai",
  "encryption",
  "isolation",
  "control",
  "incidents",
] as const;

/** «Cómo protegemos tus datos» (P5-08): public, written from what the code does (docs/compliance, ADR 0007). */
export async function SecurityPage() {
  const t = await getTranslations("security");
  const tApp = await getTranslations("app");
  return (
    <main className="mx-auto max-w-[70ch] px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
        <Logo size={30} />
        <span>{tApp("name")}</span>
      </Link>
      <h1 className="text-[28px] leading-[1.1]">{t("title")}</h1>
      <p className="mt-3 text-[15.5px] text-ink2">{t("intro")}</p>
      <div className="mt-6 flex flex-col gap-5 text-[15.5px]">
        {SECURITY_SECTIONS.map((s) => (
          <section key={s} aria-labelledby={`security-${s}`}>
            <h2 id={`security-${s}`} className="text-[19px] font-semibold">
              {t(`sections.${s}.title`)}
            </h2>
            <p className="mt-1">{t(`sections.${s}.body`)}</p>
          </section>
        ))}
      </div>
      <p className="mt-8 text-[13.5px] text-ink2">
        <Link href="/privacy" className="underline">
          {t("privacy")}
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="underline">
          {t("terms")}
        </Link>{" "}
        ·{" "}
        <Link href="/" className="underline">
          {t("back")}
        </Link>
      </p>
    </main>
  );
}
