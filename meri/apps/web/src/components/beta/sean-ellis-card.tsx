"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ClientApiError, clientApi } from "@/lib/client-api";
import { keys, useApiMutation, useNextSurvey } from "@/lib/hooks/use-api";

type Answer = "very" | "somewhat" | "not" | "na";
const ANSWERS: readonly Answer[] = ["very", "somewhat", "not", "na"];

/**
 * Sean Ellis question in Hoy (D-101): shown only when the API says it is due, dismissible («Ahora no» waits 30 days,
 * at most twice). One answer per account.
 */
export function SeanEllisCard() {
  const t = useTranslations("survey");
  const { toast } = useToast();
  const next = useNextSurvey();
  const qc = useQueryClient();
  /** The card disappears after an answer: keep keyboard focus on the page instead of losing it to <body>. */
  const keepFocus = () => document.querySelector<HTMLElement>("main h1")?.focus();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [comment, setComment] = useState("");
  const send = useApiMutation(
    (body: { answer: Answer; comment?: string } | { dismiss: true }) =>
      clientApi("/v1/surveys/sean_ellis", { method: "POST", json: body }),
    [keys.surveys],
    {
      onSuccess: (_d, body) => {
        toast("dismiss" in body ? t("dismissed") : t("thanks"));
        keepFocus();
      },
      onError: (e) => {
        // Already answered in another tab: just hide the card.
        if (e instanceof ClientApiError && e.problem.code === "CONFLICT") {
          void qc.invalidateQueries({ queryKey: keys.surveys });
          keepFocus();
        } else toast(t("error"));
      },
    },
  );
  if (next.data?.survey !== "sean_ellis") return null;
  return (
    <section aria-labelledby="sean-ellis-title" className="mt-6 rounded-2xl border border-rule bg-raised p-5">
      <p className="text-[12.5px] font-semibold uppercase tracking-wide text-ink3">{t("eyebrow")}</p>
      <h2 id="sean-ellis-title" className="mt-1 text-lg">
        {t("question")}
      </h2>
      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="sr-only">{t("question")}</legend>
        {ANSWERS.map((a) => (
          <label
            key={a}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-rule px-3 py-2 has-[:checked]:border-sea has-[:checked]:bg-sea-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-sea"
          >
            <input
              type="radio"
              name="sean-ellis"
              value={a}
              checked={answer === a}
              onChange={() => setAnswer(a)}
            />
            <span>{t(`answer.${a}`)}</span>
          </label>
        ))}
      </fieldset>
      <label className="mt-3 flex flex-col gap-1 text-[13px] font-semibold">
        {t("commentLabel")}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={2}
          className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
        />
      </label>
      <p className="mt-2 text-[12.5px] text-ink3">{t("privacy")}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="quiet" disabled={send.isPending} onClick={() => send.mutate({ dismiss: true })}>
          {t("later")}
        </Button>
        <Button
          variant="primary"
          disabled={answer === null || send.isPending}
          onClick={() => {
            if (answer) send.mutate({ answer, ...(comment.trim() ? { comment: comment.trim() } : {}) });
          }}
        >
          {t("send")}
        </Button>
      </div>
    </section>
  );
}
