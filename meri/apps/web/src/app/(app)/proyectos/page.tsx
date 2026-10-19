import { getTranslations } from "next-intl/server";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/ui/empty-state";

export default async function ProyectosPage() {
  const t = await getTranslations("proyectos");
  const nav = await getTranslations("nav");
  const tabs = ["compromisos", "clientes", "tiempo"] as const;
  return (
    <>
      <PageHeader title={nav("proyectos")} subtitle={t("subtitle")} action={<CaptureButton />} />
      {/* Static section list until the tabs get content (phases 2 and 3). */}
      <ul className="mb-1.5 flex gap-1 border-b border-rule">
        {tabs.map((tab, i) => (
          <li
            key={tab}
            aria-current={i === 0 ? "true" : undefined}
            className={
              i === 0
                ? "-mb-px border-b-2 border-sea px-3.5 py-2.5 font-semibold text-ink"
                : "-mb-px border-b-2 border-transparent px-3.5 py-2.5 font-semibold text-ink2"
            }
          >
            {t(`tabs.${tab}`)}
          </li>
        ))}
      </ul>
      <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
    </>
  );
}
