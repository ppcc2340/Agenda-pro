"use client";

import { MessageSquarePlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { ClientApiError, clientApi } from "@/lib/client-api";
import { useApiMutation } from "@/lib/hooks/use-api";

type Kind = "bug" | "idea" | "other";

/**
 * «Enviar comentarios» (D-099): kind, text and the current page path (no query). Stored in the workspace; never sent
 * to analytics or to the AI.
 */
export function FeedbackDialog({ triggerClassName }: { triggerClassName?: string }) {
  const t = useTranslations("feedback");
  const pathname = usePathname();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<"limit" | "error" | null>(null);
  const send = useApiMutation(
    (body: { kind: Kind; message: string; pagePath: string }) =>
      clientApi<{ id: string }>("/v1/feedback", { method: "POST", json: body }),
    [],
    {
      onSuccess: () => {
        toast(t("thanks"));
        setMessage("");
        setError(null);
        setOpen(false);
      },
      // Shown in the dialog, in the person's language: the text they wrote stays there to retry.
      onError: (e) =>
        setError(e instanceof ClientApiError && e.problem.code === "RATE_LIMITED" ? "limit" : "error"),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          <MessageSquarePlus size={16} aria-hidden="true" />
          <span>{t("open")}</span>
        </button>
      </DialogTrigger>
      <DialogContent
        title={t("title")}
        description={t("body")}
        footer={
          <Button
            variant="primary"
            disabled={message.trim().length === 0 || send.isPending}
            onClick={() => {
              setError(null);
              send.mutate({ kind, message: message.trim(), pagePath: pathname });
            }}
          >
            {t("send")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <Segmented
            label={t("kindLabel")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "bug", label: t("kind.bug") },
              { value: "idea", label: t("kind.idea") },
              { value: "other", label: t("kind.other") },
            ]}
          />
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            {t("messageLabel")}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
              rows={5}
              className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
            />
          </label>
          <p className="text-[12.5px] text-ink3">{t("privacy")}</p>
          {error ? (
            <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-risk">
              {t(error)}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
