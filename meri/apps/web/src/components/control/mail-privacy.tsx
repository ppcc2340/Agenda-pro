"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { keys, useApiMutation, useIntegrations, useMailExclusions } from "@/lib/hooks/use-api";
import type { IntegrationAccount, MailExclusion } from "@/lib/types";

const RETENTION_CHOICES = [7, 30, 90, 180, 365] as const;

/**
 * Privacy controls for mail (P2-13, D-036): pause reading, exclude senders/domains/labels, disconnect and purge, and
 * how long snippets and dismissed proposals are kept (7–365 days, ADR 0007).
 */
export function MailPrivacy({ retentionDays }: { retentionDays: number }) {
  const t = useTranslations("control.mailPrivacy");
  const tConn = useTranslations("connections");
  const tApp = useTranslations("app");
  const { toast } = useToast();
  const integrations = useIntegrations();
  const exclusions = useMailExclusions();
  const [kind, setKind] = useState<MailExclusion["kind"]>("sender");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState(retentionDays);
  const google = integrations.data?.items.find((i) => i.provider === "google") ?? null;
  const gmail = google?.scopes.some((s) => s.includes("gmail.readonly")) ?? false;

  const pause = useApiMutation(
    (id: string) => clientApi<IntegrationAccount>(`/v1/integrations/${id}/pause`, { method: "POST" }),
    [keys.integrations],
    { onSuccess: (a) => toast(a.status === "paused" ? t("pausedToast") : t("resumedToast")) },
  );
  const disconnect = useApiMutation(
    (id: string) => clientApi(`/v1/integrations/${id}`, { method: "DELETE" }),
    [keys.integrations, keys.proposals, ["commitments"] as const],
    { onSuccess: () => toast(t("purgedToast")) },
  );
  const add = useApiMutation(
    (vars: { kind: MailExclusion["kind"]; value: string }) =>
      clientApi<MailExclusion>("/v1/mail/exclusions", { method: "POST", json: vars }),
    [keys.exclusions],
    {
      onSuccess: () => {
        setValue("");
        setError(null);
      },
      onError: (e) =>
        setError(e instanceof ClientApiError && e.problem.status === 400 ? t("invalid") : tApp("errorBody")),
    },
  );
  const saveRetention = useApiMutation(
    (days: number) => clientApi("/v1/preferences", { method: "PUT", json: { retentionDays: days } }),
    [],
    {
      onSuccess: (_r, days) => toast(t("retentionSaved", { days })),
      onError: () => {
        setRetention(retentionDays);
        toast(tApp("errorBody"));
      },
    },
  );
  const remove = useApiMutation(
    (id: string) => clientApi(`/v1/mail/exclusions/${id}`, { method: "DELETE" }),
    [keys.exclusions],
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {google && gmail ? (
          <>
            <Pill variant={google.status === "paused" ? "plain" : "ok"}>
              {google.status === "paused" ? t("statusPaused") : t("statusReading")}
            </Pill>
            <Button size="sm" onClick={() => pause.mutate(google.id)} disabled={pause.isPending}>
              {google.status === "paused" ? t("resume") : t("pauseReading")}
            </Button>
            <Button
              size="sm"
              variant="risk"
              onClick={() => {
                if (window.confirm(tConn("confirmDisconnect"))) disconnect.mutate(google.id);
              }}
            >
              {t("disconnectPurge")}
            </Button>
          </>
        ) : (
          <Pill variant="plain">{t("notConnected")}</Pill>
        )}
      </div>
      <p className="text-[13.5px] text-ink2">{t("pauseHint")}</p>
      <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink2">
        <label htmlFor="retention-days">{t("retentionLabel")}</label>
        <select
          id="retention-days"
          value={retention}
          disabled={saveRetention.isPending}
          onChange={(e) => {
            const days = Number(e.target.value);
            setRetention(days);
            saveRetention.mutate(days);
          }}
          className="rounded-lg border border-rule bg-raised px-2.5 py-1.5 text-ink"
        >
          {(RETENTION_CHOICES.includes(retention as (typeof RETENTION_CHOICES)[number])
            ? RETENTION_CHOICES
            : [...RETENTION_CHOICES, retention].sort((a, b) => a - b)
          ).map((d) => (
            <option key={d} value={d}>
              {t("retentionOption", { days: d })}
            </option>
          ))}
        </select>
      </div>
      <p className="text-[13.5px] text-ink2">{t("retention", { days: retention })}</p>
      <div>
        <h4 className="mb-1 font-semibold">{t("exclusions")}</h4>
        <p className="mb-2 text-[13.5px] text-ink2">{t("exclusionsBody")}</p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) add.mutate({ kind, value: value.trim() });
          }}
        >
          <label className="sr-only" htmlFor="exclusion-kind">
            {t("kindLabel")}
          </label>
          <select
            id="exclusion-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as MailExclusion["kind"])}
            className="rounded-lg border border-rule bg-raised px-2.5 py-1.5"
          >
            <option value="sender">{t("kind.sender")}</option>
            <option value="domain">{t("kind.domain")}</option>
            <option value="label">{t("kind.label")}</option>
          </select>
          <label className="sr-only" htmlFor="exclusion-value">
            {t("valueLabel")}
          </label>
          <input
            id="exclusion-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t(`placeholder.${kind}`)}
            className="min-w-[220px] rounded-lg border border-rule bg-raised px-2.5 py-1.5"
          />
          <Button type="submit" size="sm" disabled={add.isPending || value.trim().length === 0}>
            {t("add")}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="mt-1 text-[13px] text-risk">
            {error}
          </p>
        ) : null}
        <ul className="mt-2 divide-y divide-rule">
          {(exclusions.data?.items ?? []).map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-1.5 text-[13.5px]">
              <span>
                <Pill variant="plain" className="mr-2">
                  {t(`kind.${e.kind}`)}
                </Pill>
                {e.value}
              </span>
              <Button
                size="sm"
                variant="quiet"
                aria-label={t("removeAria", { value: e.value })}
                onClick={() => remove.mutate(e.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        {exclusions.data && exclusions.data.items.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink3">{t("noExclusions")}</p>
        ) : null}
      </div>
    </div>
  );
}
