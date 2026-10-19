"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/pill";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { idempotencyKey } from "@/lib/hooks/use-api";
import type { Briefing, BriefingItem } from "@/lib/types";

const KIND_ORDER: BriefingItem["kind"][] = ["risk", "commitment", "pending", "decision", "communication"];
const KIND_PILL: Record<BriefingItem["kind"], "risk" | "plain" | "sug" | "sea" | "ok"> = {
  risk: "risk",
  commitment: "plain",
  pending: "sea",
  decision: "sug",
  communication: "plain",
};

/** F-11: briefing of a client; every claim shows its kind and links to its source (AC2). */
export function BriefingDialog({
  target,
  onClose,
}: {
  target: { clientId: string; clientName: string; eventId?: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations("clients.briefing");
  const tApp = useTranslations("app");
  const format = useFormatter();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generate = (clientId: string, eventId?: string) => {
    setLoading(true);
    setError(null);
    return clientApi<Briefing>(`/v1/clients/${clientId}/briefing`, {
      method: "POST",
      json: eventId ? { eventId } : {},
      headers: { "idempotency-key": idempotencyKey() },
    })
      .then(setBriefing)
      .catch((e: unknown) => {
        setError(e instanceof ClientApiError ? e.message : tApp("errorBody"));
      })
      .finally(() => {
        setLoading(false);
      });
  };
  useEffect(() => {
    if (!target) {
      setBriefing(null);
      return;
    }
    void generate(target.clientId, target.eventId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generate is stable per target
  }, [target?.clientId, target?.eventId]);
  const grouped = KIND_ORDER.map((kind) => ({ kind, items: briefing?.items.filter((i) => i.kind === kind) ?? [] })).filter(
    (g) => g.items.length > 0,
  );
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      {target ? (
        <DialogContent
          title={t("title", { name: target.clientName })}
          description={
            briefing
              ? t("generated", {
                  when: format.dateTime(new Date(briefing.generatedAt), { dateStyle: "medium", timeStyle: "short" }),
                  source: briefing.source === "ai" ? t("sourceAi") : t("sourceRules"),
                })
              : t("desc")
          }
          footer={
            <>
              <Button variant="quiet" disabled={loading} onClick={() => void generate(target.clientId, target.eventId)}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("refresh")}
              </Button>
              <Button onClick={onClose}>{t("close")}</Button>
            </>
          }
        >
          {loading && !briefing ? <p className="py-4 text-ink3">{t("loading")}</p> : null}
          {error ? (
            <p role="alert" className="py-2 text-risk">
              {error}
            </p>
          ) : null}
          {briefing && briefing.items.length === 0 ? <p className="py-4 text-ink2">{t("empty")}</p> : null}
          <div className="grid gap-4">
            {grouped.map((g) => (
              <section key={g.kind} aria-label={t(`kind.${g.kind}`)}>
                <h3 className="mb-1.5 text-[12.5px] font-semibold uppercase tracking-wide text-ink3">{t(`kind.${g.kind}`)}</h3>
                <ul className="grid gap-1.5">
                  {g.items.map((item) => (
                    <li key={item.sourceId} className="flex items-start gap-2 rounded-lg border border-rule bg-panel px-3 py-2">
                      <Pill variant={KIND_PILL[item.kind]}>{t(`source.${item.sourceType}`)}</Pill>
                      <div className="min-w-0 flex-1">
                        <div>{item.claim}</div>
                        {item.url ? (
                          item.url.startsWith("http") ? (
                            <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-ink2 underline-offset-2 hover:underline">
                              <ExternalLink size={12} aria-hidden="true" />
                              {t("openSource", { title: item.sourceTitle ?? "" })}
                            </a>
                          ) : (
                            <Link href={item.url} className="text-[12.5px] text-ink2 underline-offset-2 hover:underline" onClick={onClose}>
                              {t("openSource", { title: item.sourceTitle ?? "" })}
                            </Link>
                          )
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
