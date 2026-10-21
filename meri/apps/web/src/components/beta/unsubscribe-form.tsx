"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientApiError, clientApi } from "@/lib/client-api";

/** The one-click unsubscribe, behind a button (D-116): a GET from a link scanner never unsubscribes anyone. */
export function UnsubscribeForm({ token }: { token: string }) {
  const t = useTranslations("unsubscribe");
  const [state, setState] = useState<"idle" | "sending" | "done" | "invalid" | "error">("idle");
  const doneRef = useRef<HTMLParagraphElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state === "done") doneRef.current?.focus();
    // The button was disabled while sending: give focus back so a retry is one key away.
    if (state === "invalid" || state === "error") buttonRef.current?.focus();
  }, [state]);
  async function submit(): Promise<void> {
    setState("sending");
    try {
      await clientApi(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`, { method: "POST", json: {} });
      setState("done");
    } catch (e) {
      setState(e instanceof ClientApiError && e.problem.code === "VALIDATION_FAILED" ? "invalid" : "error");
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
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-ink2">{t("body")}</p>
      {state === "invalid" || state === "error" ? (
        <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-risk">
          {t(state)}
        </p>
      ) : null}
      <Button
        ref={buttonRef}
        variant="primary"
        size="block"
        disabled={state === "sending"}
        onClick={() => void submit()}
      >
        {t("confirm")}
      </Button>
    </div>
  );
}
