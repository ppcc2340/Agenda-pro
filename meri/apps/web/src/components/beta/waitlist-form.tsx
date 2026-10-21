"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientApi } from "@/lib/client-api";

/**
 * Closed-beta waitlist (D-099, SEC-M4): address, explicit consent with a link to the privacy policy, and a hidden
 * field that only bots fill. The answer is the same whether or not the address was already there.
 */
export function WaitlistForm() {
  const t = useTranslations("waitlist");
  const locale = useLocale();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  async function submit(form: FormData): Promise<void> {
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    setState("sending");
    try {
      await clientApi("/v1/waitlist", {
        method: "POST",
        json: {
          email: field("email"),
          consent: form.get("consent") === "on",
          locale: locale === "en" ? "en" : "es",
          website: field("website"),
        },
      });
      setState("done");
    } catch {
      setState("error");
    }
  }
  if (state === "done")
    return (
      <p role="status" className="mt-4 rounded-lg bg-panel px-3 py-2">
        {t("done")}
      </p>
    );
  return (
    <form action={submit} className="mt-4 flex flex-col gap-3" aria-label={t("title")}>
      <label className="flex flex-col gap-1 text-[13px] font-semibold">
        {t("email")}
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
        />
      </label>
      {/* Honeypot: invisible to people and to assistive technology. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          {t("website")}
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input name="consent" type="checkbox" required className="mt-0.5" />
        <span>
          {t.rich("consent", {
            privacy: (chunks) => (
              <Link href="/privacy" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </span>
      </label>
      {state === "error" ? (
        <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-risk">
          {t("error")}
        </p>
      ) : null}
      <Button type="submit" variant="default" size="block" disabled={state === "sending"}>
        {t("submit")}
      </Button>
    </form>
  );
}
