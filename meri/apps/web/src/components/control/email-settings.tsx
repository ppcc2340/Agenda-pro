"use client";

import { EMAIL_PREFERENCES, type EmailPreference } from "@meri/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation } from "@/lib/hooks/use-api";

/**
 * Which notifications also arrive by email (D-114): none, the morning summary and account notices (default), or
 * everything. Emails carry counts and a link, never the content of tasks, clients or mail.
 */
export function EmailSettings({ value }: { value: EmailPreference }) {
  const t = useTranslations("control.email");
  const { toast } = useToast();
  const [current, setCurrent] = useState<EmailPreference>(value);
  // The last value the server confirmed: a failed save goes back to it, not to the page-load value.
  const saved = useRef<EmailPreference>(value);
  useEffect(() => {
    saved.current = value;
    setCurrent(value);
  }, [value]);
  const save = useApiMutation(
    (v: EmailPreference) => clientApi("/v1/preferences", { method: "PUT", json: { emailNotifications: v } }),
    [keys.audit],
    {
      onSuccess: (_d, v) => {
        saved.current = v;
        toast(t("saved"));
      },
      onError: () => {
        setCurrent(saved.current);
        toast(t("error"));
      },
    },
  );
  return (
    <fieldset aria-busy={save.isPending}>
      <legend className="font-semibold">{t("legend")}</legend>
      <div className="mt-2 grid gap-2">
        {EMAIL_PREFERENCES.map((id) => (
          <label
            key={id}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-rule bg-raised px-4 py-3 has-[:checked]:border-sea has-[:checked]:bg-sea-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-sea"
          >
            <input
              type="radio"
              name="email-notifications"
              value={id}
              checked={current === id}
              onChange={() => {
                setCurrent(id);
                save.mutate(id);
              }}
              className="mt-1"
            />
            <span>
              <b>{t(`${id}.title`)}</b>
              <span className="block text-[13.5px] text-ink2">{t(`${id}.desc`)}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-ink2">{t("privacy")}</p>
    </fieldset>
  );
}
