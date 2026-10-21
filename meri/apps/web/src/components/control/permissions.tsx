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
  "https://www.googleapis.com/auth/calendar.app.created": "calendarWrite",
  // Grants made before D-093: wider than Meri needs; the text says so and invites a reconnect.
  "https://www.googleapis.com/auth/calendar.events": "calendarWriteLegacy",
  openid: "identity",
  email: "identity",
  profile: "identity",
  "https://www.googleapis.com/auth/userinfo.email": "identity",
  "https://www.googleapis.com/auth/userinfo.profile": "identity",
};

/** One line per permission: identity scopes collapse into a single plain-language entry. */
const permissionLines = (scopes: string[]): { id: string; key: string | null }[] => {
  const seen = new Set<string>();
  return scopes.flatMap((scope) => {
    const key = SCOPE_KEYS[scope] ?? null;
    const id = key ?? scope;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, key }];
  });
};

/**
 * «Permisos» (P5-05): what each connection really granted, read from the scopes Google returned, in plain words,
 * next to what Meri never does whatever the permission. Decisions about autonomy live in their own panel.
 */
export function PermissionsPanel() {
  const t = useTranslations("control.permissions");
  const integrations = useIntegrations();
  if (integrations.isPending) return <p className="text-ink2">{t("loading")}</p>;
  if (!integrations.data)
    return <LoadError message={t("unavailable")} onRetry={() => void integrations.refetch()} />;
  const live = integrations.data.items.filter((i) => i.status !== "revoked");
  return (
    <div className="grid gap-4">
      {live.length === 0 ? (
        <p className="text-ink2">{t("none")}</p>
      ) : (
        live.map((account) => (
          <div key={account.id}>
            <h4 className="font-semibold">{t("account", { email: account.email ?? t("unknownEmail") })}</h4>
            <ul className="mt-1 space-y-1 text-[13.5px]" aria-label={t("granted")}>
              {permissionLines(account.scopes).map(({ id, key }) => (
                <li key={id} className="flex gap-2">
                  <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
                  <span>{key ? t(`scopes.${key}`) : id}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <div>
        <h4 className="font-semibold">{t("neverTitle")}</h4>
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
