"use client";

import { Archive, ArchiveRestore, FileText, Pencil, Plus, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { formatMinutes } from "@/lib/format";
import { idempotencyKey, keys, useApiMutation, useClients } from "@/lib/hooks/use-api";
import { clientColorVar } from "@/lib/plan";
import type { Client } from "@/lib/types";
import { BriefingDialog } from "./briefing-dialog";
import { ClientForm, type ClientFormValues } from "./client-form";

/** Clientes tab (F-09, demo tabClientes): colour, open commitments, week hours, risks; create / edit / archive. */
export function ClientList({ editId = null }: { editId?: string | null }) {
  const t = useTranslations("clients");
  const tApp = useTranslations("app");
  const tTasks = useTranslations("tasks");
  const hours = (min: number) => formatMinutes(min, (key, values) => tTasks(key, values));
  const { toast } = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [open, setOpen] = useState(false);
  const [autoEdited, setAutoEdited] = useState(false);
  const [briefing, setBriefing] = useState<{ clientId: string; clientName: string } | null>(null);
  const list = useClients({ stats: true, includeArchived: showArchived });
  const invalidate = [keys.clients, keys.audit];
  const save = useApiMutation(
    ({ id, values }: { id: string | null; values: ClientFormValues }) =>
      id
        ? clientApi<Client>(`/v1/clients/${id}`, { method: "PATCH", json: values })
        : clientApi<Client>("/v1/clients", {
            method: "POST",
            json: values,
            headers: { "idempotency-key": idempotencyKey() },
          }),
    invalidate,
  );
  const archive = useApiMutation(
    ({ id, archived }: { id: string; archived: boolean }) =>
      clientApi<Client>(`/v1/clients/${id}`, { method: "PATCH", json: { archived } }),
    invalidate,
  );
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const active = items.filter((c) => !c.archivedAt);
  // Deep link from the client view ("Editar"): open the form once for that client.
  useEffect(() => {
    if (!editId || autoEdited) return;
    const target = items.find((c) => c.id === editId);
    if (!target) return;
    setEditing(target);
    setOpen(true);
    setAutoEdited(true);
  }, [editId, autoEdited, items]);
  const onError = (err: unknown) => {
    toast(err instanceof ClientApiError && err.problem.code === "ENTITLEMENT_REQUIRED" ? t("limit") : tApp("errorBody"));
  };
  return (
    <div>
      <div className="my-3.5 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          {t("new")}
        </Button>
        <button
          type="button"
          aria-pressed={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="inline-flex items-center rounded-full border border-rule bg-raised px-2.5 py-1 text-[13px] aria-pressed:border-sea aria-pressed:bg-sea-soft"
        >
          {t("showArchived")}
        </button>
      </div>
      {list.isPending ? <p className="py-6 text-ink3">{tApp("loading")}</p> : null}
      {list.isError ? (
        <p role="alert" className="py-6 text-risk">
          {tApp("errorBody")}
        </p>
      ) : null}
      {list.data && items.length === 0 ? <EmptyState title={t("emptyTitle")} body={t("emptyBody")} /> : null}
      <ul className="divide-y divide-rule border-t border-rule" aria-label={t("listLabel")}>
        {items.map((c) => {
          const s = c.stats;
          const color = clientColorVar(c.id, active.length ? active : items);
          const risk = s ? s.atRiskTasks + s.overdueCommitments : 0;
          return (
            <li key={c.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:gap-3.5">
              <div className="flex min-w-0 flex-1 items-center gap-3.5">
                <span className="h-[38px] w-2 shrink-0 rounded" style={{ background: color }} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/clientes/${c.id}`} className="truncate font-head text-[16px] font-semibold underline-offset-2 hover:underline">
                      {c.name}
                    </Link>
                    {c.archivedAt ? <Pill variant="plain">{t("archived")}</Pill> : null}
                  </div>
                  {s ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink2">
                      <span className="num">{t("stats.open", { n: s.openCommitments })}</span>
                      <span aria-hidden="true">·</span>
                      <span className="num">{t("stats.weekHours", { h: hours(s.minutesApproved) })}</span>
                      {s.minutesSuggested > 0 ? (
                        <Pill variant="sug" className="font-normal">
                          {t("stats.suggested", { h: hours(s.minutesSuggested) })}
                        </Pill>
                      ) : null}
                      {risk > 0 ? (
                        <Pill variant="risk">{t("stats.risk", { n: risk })}</Pill>
                      ) : (
                        <Pill variant="ok">{t("stats.noRisk")}</Pill>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 md:justify-end">
                <Button
                  size="sm"
                  disabled={Boolean(c.archivedAt)}
                  onClick={() => setBriefing({ clientId: c.id, clientName: c.name })}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span className="md:hidden">{t("briefing.openShort")}</span>
                  <span className="hidden md:inline">{t("briefing.open")}</span>
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    setEditing(c);
                    setOpen(true);
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  {t("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={archive.isPending}
                  onClick={() =>
                    archive.mutate(
                      { id: c.id, archived: !c.archivedAt },
                      { onSuccess: () => toast(c.archivedAt ? t("toasts.restored") : t("toasts.archived")), onError },
                    )
                  }
                >
                  {c.archivedAt ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                  {c.archivedAt ? t("restore") : t("archive")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink3">
        <ShieldCheck size={14} aria-hidden="true" />
        {t("isolationNote")}
      </p>
      <BriefingDialog target={briefing} onClose={() => setBriefing(null)} />
      <ClientForm
        key={editing?.id ?? "new"}
        open={open}
        onOpenChange={setOpen}
        client={editing}
        onSubmit={(values) =>
          save
            .mutateAsync({ id: editing?.id ?? null, values })
            .then(() => {
              setOpen(false);
              toast(editing ? t("toasts.updated") : t("toasts.created"));
            })
            .catch(onError)
        }
      />
    </div>
  );
}
