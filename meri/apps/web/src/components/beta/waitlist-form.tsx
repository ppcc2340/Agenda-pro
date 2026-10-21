"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientApiError, clientApi } from "@/lib/client-api";

/**
 * Closed-beta waitlist (D-099, SEC-M4): address, explicit consent with a link to the privacy policy, and a hidden
 * field that only bots fill. The answer is the same whether or not the address was already there.
 */
export function WaitlistForm() {
  const t = useTranslations("waitlist");
  const locale = useLocale();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error" | "limit">("idle");
  const doneRef = useRef<HTMLParagraphElement>(null);
  // The form is replaced by the confirmation: move focus there so it is announced and not lost.
  useEffect(() => {
    if (state === "done") doneRef.current?.focus();
  }, [state]);
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
          // The honeypot has a neutral name in the page (autofill ignores it); the API field is `website`.
          website: field("mr_hp"),
        },
      });
      setState("done");
    } catch (e) {
      setState(e instanceof ClientApiError && e.problem.code === "RATE_LIMITED" ? "limit" : "error");
    }
  }
  if (state === "done")
    return (
      <p
        ref={doneRef}
        tabIndex={-1}
        role="status"
        className="mt-4 rounded-lg bg-panel px-3 py-2 outline-none"
      >
        {t("done")}
      </p>
    );
  return (
    <form action={submit} className="mt-4 flex flex-col gap-3">
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
          <input name="mr_hp" type="text" tabIndex={-1} autoComplete="off" />
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
      {state === "error" || state === "limit" ? (
        <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-risk">
          {t(state)}
        </p>
      ) : null}
      <Button type="submit" variant="default" size="block" disabled={state === "sending"}>
        {t("submit")}
      </Button>
    </form>
  );
}
