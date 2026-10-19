"use client";

import { Mail } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";
import type { FollowupDraft, Task } from "@/lib/types";

export interface FollowupTarget {
  commitmentId: string;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  /** When the dialog comes from a `followup` proposal, saving or reminding resolves it. */
  proposalId?: string;
}

/**
 * "Seguimiento para …" (F-08, demo openFollowup): the body is editable; the recipient and subject come from the
 * thread. Meri only creates drafts. The reminder creates a task for tomorrow.
 */
export function FollowupDialog({ target, onClose }: { target: FollowupTarget | null; onClose: () => void }) {
  const t = useTranslations("followup");
  const tApp = useTranslations("app");
  const locale = useLocale();
  const { toast } = useToast();
  const [draft, setDraft] = useState<FollowupDraft | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const invalidate = [["commitments"] as const, keys.proposals, keys.audit, ["tasks"] as const];

  useEffect(() => {
    if (!target) return;
    setDraft(null);
    setError(null);
    let cancelled = false;
    clientApi<FollowupDraft>(`/v1/commitments/${target.commitmentId}/followup-draft`, {
      method: "POST",
      json: { language: locale === "en" ? "en" : "es" },
    })
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        setBody(d.body);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ClientApiError ? e.message : tApp("errorBody"));
      });
    return () => {
      cancelled = true;
    };
  }, [target, locale, tApp]);

  const save = useApiMutation(
    (vars: { body: string; subject: string }) =>
      clientApi<{ draftId: string; to: string }>(
        `/v1/commitments/${target?.commitmentId ?? ""}/followup-draft/save`,
        {
          method: "POST",
          json: { ...vars, language: locale === "en" ? "en" : "es", proposalId: target?.proposalId },
          headers: { "idempotency-key": idempotencyKey() },
        },
      ),
    invalidate,
    {
      onSuccess: () => {
        toast(t("savedToast"));
        onClose();
      },
      onError: (e) => setError(e instanceof ClientApiError ? e.message : tApp("errorBody")),
    },
  );
  const remind = useApiMutation(
    () =>
      clientApi<{ task: Task }>(`/v1/commitments/${target?.commitmentId ?? ""}/remind`, {
        method: "POST",
        json: { proposalId: target?.proposalId },
      }),
    invalidate,
    {
      onSuccess: () => {
        toast(t("remindToast"));
        onClose();
      },
    },
  );

  const who = target?.counterpartyName ?? target?.counterpartyEmail ?? "";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {target ? (
        <DialogContent
          title={t("title", { who })}
          description={draft ? t("meta", { to: draft.to, subject: draft.subject }) : tApp("loading")}
          footer={
            <>
              <span className="mr-auto text-[12.5px] text-ink3">{t("note")}</span>
              <Button onClick={onClose}>{t("cancel")}</Button>
              <Button onClick={() => remind.mutate(undefined)} disabled={remind.isPending}>
                {t("remind")}
              </Button>
              <Button
                variant="primary"
                disabled={!draft || save.isPending || body.trim().length < 20}
                onClick={() => draft && save.mutate({ body, subject: draft.subject })}
              >
                <Mail size={15} aria-hidden="true" />
                {t("save")}
              </Button>
            </>
          }
        >
          {error ? (
            <p role="alert" className="mb-2 text-risk">
              {error}
            </p>
          ) : null}
          <label htmlFor="followup-body" className="sr-only">
            {t("bodyLabel")}
          </label>
          <textarea
            id="followup-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={9}
            disabled={!draft}
            className="w-full resize-y rounded-lg border border-rule bg-raised px-3 py-2 leading-relaxed"
          />
          {draft ? (
            <p className="mt-1.5 text-[12.5px] text-ink3">
              {draft.source === "ai" ? t("sourceAi") : t("sourceTemplate")}
            </p>
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
