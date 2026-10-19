"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { keys, useApiMutation, useIntegrations } from "@/lib/hooks/use-api";
import type { IntegrationAccount } from "@/lib/types";

const PILL: Record<IntegrationAccount["status"], "ok" | "risk" | "sug" | "plain"> = {
  healthy: "ok",
  needs_reauth: "risk",
  degraded: "sug",
  paused: "plain",
  revoked: "risk",
};

export function ConnectionsPanel({ fakeMode, timezone }: { fakeMode: boolean; timezone: string }) {
  const t = useTranslations("connections");
  const tc = useTranslations("control.connections");
  const locale = useLocale();
  const { toast } = useToast();
  const params = useSearchParams();
  const integrations = useIntegrations();
  useEffect(() => {
    const flag = params.get("integration");
    if (flag === "connected") toast(t("connected"));
    if (flag === "denied") toast(t("denied"));
  }, [params, t, toast]);

  const connect = useApiMutation(
    (feature: "calendar" | "gmail" | "all" = "calendar") =>
      clientApi<{ url: string }>(`/v1/integrations/google/connect?feature=${feature}`, { method: "POST" }),
    [],
    {
      onSuccess: (r) => {
        window.location.assign(r.url);
      },
    },
  );
  const pause = useApiMutation(
    (id: string) => clientApi<IntegrationAccount>(`/v1/integrations/${id}/pause`, { method: "POST" }),
    [keys.integrations],
  );
  const sync = useApiMutation(
    (id: string) => clientApi(`/v1/integrations/${id}/sync`, { method: "POST" }),
    [keys.integrations],
    { onSuccess: () => toast(t("syncQueued")) },
  );
  const disconnect = useApiMutation(
    (id: string) => clientApi(`/v1/integrations/${id}`, { method: "DELETE" }),
    [keys.integrations],
    { onSuccess: () => toast(t("disconnected")) },
  );
  const google = integrations.data?.items.find((i) => i.provider === "google") ?? null;
  const gmail = google?.scopes.some((s) => s.includes("gmail.readonly")) ?? false;
  const syncMail = useApiMutation(
    (id: string) => clientApi(`/v1/integrations/${id}/mail/sync`, { method: "POST" }),
    [keys.integrations, keys.proposals],
    { onSuccess: () => toast(t("syncQueued")) },
  );

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-dashed border-rule py-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <b>{tc("calendar")}</b>
          <div className="text-ink2">{tc("calendarScope")}</div>
          {google ? (
            <div className="num text-[12.5px] text-ink3">
              {google.lastSyncAt
                ? t("lastSync", { date: formatDateTime(google.lastSyncAt, locale, timezone) })
                : t("neverSynced")}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {google ? (
            <>
              <Pill variant={PILL[google.status]}>{t(`status.${google.status}`)}</Pill>
              {google.status === "needs_reauth" ? (
                <Button size="sm" variant="primary" onClick={() => connect.mutate("all")}>
                  {t("status.needs_reauth")}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => sync.mutate(google.id)} disabled={google.status === "paused"}>
                {t("sync")}
              </Button>
              <Button size="sm" onClick={() => pause.mutate(google.id)}>
                {google.status === "paused" ? t("resume") : t("pause")}
              </Button>
              <Button
                size="sm"
                variant="risk"
                onClick={() => {
                  if (window.confirm(t("confirmDisconnect"))) disconnect.mutate(google.id);
                }}
              >
                {t("disconnect")}
              </Button>
            </>
          ) : (
            <>
              <Pill variant="plain">{tc("notConnected")}</Pill>
              <Button
                size="sm"
                variant="primary"
                onClick={() => connect.mutate("calendar")}
                disabled={connect.isPending}
              >
                {t("connect")}
              </Button>
            </>
          )}
        </div>
      </div>
      {fakeMode ? <p className="pt-2 text-[12.5px] text-ink3">{t("fakeNote")}</p> : null}
      <div className="flex flex-col gap-2 border-b border-dashed border-rule py-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <b>{tc("gmail")}</b>
          <div className="text-ink2">{tc("gmailScope")}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {gmail ? (
            <>
              <Pill variant={PILL[google?.status ?? "healthy"]}>
                {t(`status.${google?.status ?? "healthy"}`)}
              </Pill>
              <Button
                size="sm"
                onClick={() => google && syncMail.mutate(google.id)}
                disabled={google?.status === "paused"}
              >
                {t("sync")}
              </Button>
            </>
          ) : (
            <>
              <Pill variant="plain">{tc("notConnected")}</Pill>
              <Button
                size="sm"
                variant="primary"
                onClick={() => connect.mutate("gmail")}
                disabled={connect.isPending}
              >
                {t("connectGmail")}
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3.5 py-2">
        <div>
          <b>{tc("others")}</b>
          <div className="text-ink2">{tc("othersBody")}</div>
        </div>
        <Pill variant="plain">{tc("soon")}</Pill>
      </div>
    </div>
  );
}
