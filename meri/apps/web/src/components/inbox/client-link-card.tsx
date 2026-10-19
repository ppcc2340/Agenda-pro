"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import type { ClientLinkPayload, Proposal } from "@/lib/types";

const CARD =
  "flex flex-col gap-3 border-b border-rule border-l-[3px] border-l-dashed border-l-sug bg-[linear-gradient(90deg,var(--sug-soft),transparent_30%)] px-4 py-4 md:flex-row md:items-start md:gap-4";

/** Entrada card for a `client_link` proposal (D-040): "create the client acme.com?" with an editable name. */
export function ClientLinkCard({
  proposal,
  busy,
  onConfirm,
  onDismiss,
}: {
  proposal: Proposal;
  busy: boolean;
  onConfirm: (edits: { name: string }) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("inbox");
  const p = proposal.payload as unknown as ClientLinkPayload;
  const [name, setName] = useState(p.suggestedName);
  return (
    <article className={CARD} aria-label={t("clientLink.title", { domain: p.domain })}>
      <div className="min-w-0 flex-1">
        <div className="text-[15.5px] font-semibold">{t("clientLink.title", { domain: p.domain })}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
          <span>{t("clientLink.seen", { contacts: p.contacts, threads: p.threads })}</span>
          <Pill variant="sug">{t("kind.client_link")}</Pill>
        </div>
        <label className="mt-2 flex max-w-[360px] flex-col gap-1 text-[13px] text-ink2">
          {t("clientLink.name")}
          <input
            name="name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-rule bg-panel px-3 py-1.5 font-normal text-ink"
          />
        </label>
      </div>
      <div className="flex shrink-0 gap-1.5 md:min-w-[150px] md:flex-col">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || name.trim().length === 0}
          onClick={() => onConfirm({ name: name.trim() })}
        >
          <Check size={14} aria-hidden="true" />
          {t("clientLink.create")}
        </Button>
        <Button size="sm" variant="quiet" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
          {t("actions.dismiss")}
        </Button>
      </div>
    </article>
  );
}
