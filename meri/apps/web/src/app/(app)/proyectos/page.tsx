import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { CaptureButton, PageHeader } from "@/components/shell/app-shell";
import { CommitmentList } from "@/components/commitments/commitment-list";
import { TaskList } from "@/components/tasks/task-list";
import { getServerConfig } from "@/server/config";
import { EmptyState } from "@/components/ui/empty-state";
import { apiFetch } from "@/server/api";

const TABS = ["tareas", "compromisos", "clientes", "tiempo"] as const;
type Tab = (typeof TABS)[number];

export default async function ProyectosPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; dir?: string }>;
}) {
  const t = await getTranslations("proyectos");
  const nav = await getTranslations("nav");
  const { tab: raw, dir } = await searchParams;
  const demoNow = getServerConfig().env.DEMO_NOW;
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "tareas";
  const [clients, prefs] = await Promise.all([
    apiFetch<{ items: { id: string; name: string }[] }>("/v1/clients").catch(() => ({ items: [] })),
    apiFetch<{ timezone: string }>("/v1/preferences"),
  ]);
  return (
    <>
      <PageHeader title={nav("proyectos")} subtitle={t("subtitle")} action={<CaptureButton />} />
      <nav className="mb-1.5 flex gap-1 border-b border-rule" aria-label={nav("proyectos")}>
        {TABS.map((key) => (
          <Link
            key={key}
            href={`/proyectos?tab=${key}`}
            aria-current={key === tab ? "page" : undefined}
            className={
              key === tab
                ? "-mb-px border-b-2 border-sea px-3.5 py-2.5 font-semibold text-ink"
                : "-mb-px border-b-2 border-transparent px-3.5 py-2.5 font-semibold text-ink2"
            }
          >
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </nav>
      {tab === "tareas" ? (
        <TaskList clients={clients.items} timezone={prefs.timezone} />
      ) : tab === "compromisos" ? (
        <CommitmentList
          clients={clients.items}
          timezone={prefs.timezone}
          now={demoNow ? new Date(demoNow).toISOString() : undefined}
          initialDirection={dir === "owed_to_me" ? "owed_to_me" : "owed_by_me"}
        />
      ) : (
        <EmptyState title={t("emptyTitle")} body={t("soon")} />
      )}
    </>
  );
}
