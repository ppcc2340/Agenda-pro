"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";
import type { Proposal } from "@/lib/types";

export interface AgreementsTarget {
  eventId: string;
  title: string;
  clientName: string | null;
}

/** D-044 "Registrar acuerdos": one agreement per line → proposals in Entrada (nothing is confirmed here). */
export function AgreementsDialog({ target, onClose }: { target: AgreementsTarget | null; onClose: () => void }) {
  const t = useTranslations("agreements");
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ proposals: Proposal[]; skipped: number } | null>(null);
  const save = useApiMutation(
    (lines: string[]) =>
      clientApi<{ proposals: Proposal[]; skipped: number }>(`/v1/events/${target?.eventId ?? ""}/agreements`, {
        method: "POST",
        json: { lines },
        headers: { "idempotency-key": idempotencyKey() },
      }),
    [keys.proposals, keys.audit],
    { onSuccess: (r) => { setResult(r); toast(t("toast", { n: r.proposals.length })); } },
  );
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3)
    .slice(0, 20);
  const close = () => {
    setText("");
    setResult(null);
    onClose();
  };
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target ? (
        <DialogContent
          title={t("title", { title: target.title })}
          description={target.clientName ? t("descClient", { client: target.clientName }) : t("desc")}
          footer={
            result ? (
              <>
                <Button asChild variant="primary">
                  <Link href="/entrada" onClick={close}>
                    {t("review")}
                  </Link>
                </Button>
                <Button onClick={close}>{t("close")}</Button>
              </>
            ) : (
              <>
                <Button variant="quiet" onClick={close}>
                  {t("cancel")}
                </Button>
                <Button variant="primary" disabled={lines.length === 0 || save.isPending} onClick={() => save.mutate(lines)}>
                  {t("submit", { n: lines.length })}
                </Button>
              </>
            )
          }
        >
          {result ? (
            <div className="grid gap-2">
              <p>{t("done", { n: result.proposals.length, skipped: result.skipped })}</p>
              <ul className="grid gap-1 text-[13.5px]">
                {result.proposals.map((p) => (
                  <li key={p.id} className="rounded-lg border border-dashed border-sug bg-panel px-3 py-1.5">
                    <b className="mr-2 text-[12px] uppercase tracking-wide text-ink3">{t(`kind.${p.kind === "commitment" ? "commitment" : "capture"}`)}</b>
                    {[p.payload["action"], p.payload["title"]].find((v): v is string => typeof v === "string") ?? ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-[13px] text-ink2">
              {t("label")}
              <textarea
                autoFocus
                rows={6}
                value={text}
                maxLength={6000}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("placeholder")}
                className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
              />
              <span className="text-[12px] text-ink3">{t("hint")}</span>
            </label>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
