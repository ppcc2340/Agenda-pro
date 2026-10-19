import { ChevronLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

/** Header of a «Más» sub-page (demo/mobile.html): back link to the list and the page title. */
export async function MasHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = await getTranslations("mas");
  return (
    <div className="mb-5">
      <Link href="/mas" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-sea">
        <ChevronLeft size={16} aria-hidden="true" />
        {t("back")}
      </Link>
      <h1 className="mt-2 text-[28px] leading-[1.1] md:text-[34px]">{title}</h1>
      {subtitle ? <p className="mt-2 max-w-[60ch] text-[15.5px] text-ink2">{subtitle}</p> : null}
    </div>
  );
}
