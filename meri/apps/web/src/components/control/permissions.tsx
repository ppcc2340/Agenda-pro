"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { LoadError } from "@/components/ui/load-error";
import { useIntegrations } from "@/lib/hooks/use-api";

/** Google scope → the plain-language permission it grants (docs/06 §1). Unknown scopes are shown as granted text. */
const SCOPE_KEYS: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly": "gmailRead",
  "https://www.googleapis.com/auth/gmail.compose": "gmailDrafts",
  "https://www.googleapis.com/auth/calendar.readonly": "calendarRead",
  "https://www.googleapis.com/auth/calendar.events": "calendarWrite",
};

/**
 * «Permisos» (P5-05): what each connection really granted, read from the scopes Google returned, in plain words,
 * next to what Meri never does whatever the permission. Decisions about autonomy live in their own panel.
 */
export function PermissionsPanel() {
  const t = useTranslations("control.permissions");
  const integrations = useIntegrations();
  if (integrations.isPending) return <p className="text-ink2">{t("loading")}</p>;
  if (!integrations.data) return <LoadError message={t("unavailable")} onRetry={() => void integrations.refetch()} />;
  const live = integrations.data.items.filter((i) => i.status !== "revoked");
  return (
    <div className="grid gap-4">
      {live.length === 0 ? (
        <p className="text-ink2">{t("none")}</p>
      ) : (
        live.map((account) => (
          <div key={account.id}>
            <p className="font-semibold">{t("account", { email: account.email ?? t("unknownEmail") })}</p>
            <ul className="mt-1 space-y-1 text-[13.5px]" aria-label={t("granted")}>
              {account.scopes.map((scope) => {
                const key = SCOPE_KEYS[scope];
                return (
                  <li key={scope} className="flex gap-2">
                    <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
                    <span>{key ? t(`scopes.${key}`) : scope}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      <div>
        <p className="font-semibold">{t("neverTitle")}</p>
        <ul className="mt-1 space-y-1 text-[13.5px]" aria-label={t("neverTitle")}>
          {(["send", "thirdParty", "train", "attachments"] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <X size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-risk" />
              <span>{t(`never.${k}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
