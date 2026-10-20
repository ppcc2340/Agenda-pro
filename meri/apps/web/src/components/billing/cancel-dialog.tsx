"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";

const REASONS = ["price", "not_using", "missing_feature", "switched_tool", "privacy", "other"] as const;
type Reason = (typeof REASONS)[number];
const MAX_COMMENT = 500;

/**
 * D-066: cancel at period end with a short, optional survey (UX review: never a gate on cancelling); the comment
 * stays in Meri (never in analytics). An unanswered reason is recorded as «other».
 */
export function CancelDialog({
  open,
  onOpenChange,
  periodEnd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodEnd: string;
}) {
  const t = useTranslations("billing.cancel");
  const { toast } = useToast();
  const [reason, setReason] = useState<Reason | null>(null);
  const [comment, setComment] = useState("");
  const cancel = useApiMutation(
    (v: { reason?: Reason; comment: string | null }) =>
      clientApi<{ status: string }>("/v1/billing/cancel", {
        method: "POST",
        json: v,
        headers: { "idempotency-key": idempotencyKey() },
      }),
    [keys.billing],
    {
      onSuccess: () => {
        toast(t("done", { date: periodEnd }));
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title={t("title")}
          description={t("desc", { date: periodEnd })}
          footer={
            <>
              <Button variant="quiet" onClick={() => onOpenChange(false)}>
                {t("keep")}
              </Button>
              <Button
                variant="risk"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate({
                    ...(reason ? { reason } : {}),
                    comment: comment.trim() ? comment.trim() : null,
                  })
                }
              >
                {t("confirm")}
              </Button>
            </>
          }
        >
          <fieldset>
            <legend className="mb-2 font-semibold">{t("question")}</legend>
            <div className="grid gap-1.5">
              {REASONS.map((r) => (
                <label key={r} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="cancel-reason"
                    value={r}
                    checked={reason === r}
                    onChange={() => setReason(r)}
                  />
                  <span>{t(`reasons.${r}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-3 block">
            <span className="mb-1 block text-[13.5px] text-ink2">{t("comment")}</span>
            <textarea
              value={comment}
              maxLength={MAX_COMMENT}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-rule bg-raised px-3 py-2"
            />
          </label>
          <p className="mt-1 text-[12.5px] text-ink3">{t("privacy")}</p>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
