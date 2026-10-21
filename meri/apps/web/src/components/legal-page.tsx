import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Logo } from "@/components/shell/logo";

/** Public legal pages (P0-13). Drafts: a person reviews them before the beta (docs/06 §8). */
export async function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const t = await getTranslations("legal");
  const tApp = await getTranslations("app");
  const paragraphs =
    kind === "privacy" ? (["p1", "p2", "p3", "p6", "p4", "p5"] as const) : (["p1", "p2", "p3", "p4"] as const);
  return (
    <main className="mx-auto max-w-[70ch] px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
        <Logo size={30} />
        <span>{tApp("name")}</span>
      </Link>
      <h1 className="text-[28px] leading-[1.1]">
        {kind === "privacy" ? t("privacyTitle") : t("termsTitle")}
      </h1>
      <p className="mt-3 rounded-lg border border-dashed border-sug bg-sug-soft px-3 py-2 text-sug">
        {t("draftNote")}
      </p>
      <div className="mt-6 flex flex-col gap-4 text-[15.5px]">
        {paragraphs.map((p) => (
          <p key={p}>
            {kind === "privacy" ? t(`privacy.${p}` as "privacy.p1") : t(`terms.${p}` as "terms.p1")}
          </p>
        ))}
      </div>
      <p className="mt-8">
        <Link href="/" className="underline">
          {t("back")}
        </Link>
      </p>
    </main>
  );
}
