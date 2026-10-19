"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Client } from "@/lib/types";

export interface ClientFormValues {
  name: string;
  domains: string[];
  color: string | null;
  notes: string | null;
  verticalTags: string[];
}

const field = "rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink";
// docs/11 client colours first (they map to the --c-1..4 tokens, so they lighten in the dark theme), then two
// extra tones of similar chroma.
const PALETTE = ["#3A6EDB", "#2F8A5C", "#B07414", "#B0407E", "#1F6F8B", "#7C6FD6"];

const splitList = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** Create / edit a client (F-09): name, domains for automatic resolution, colour, tags and notes. */
export function ClientForm({
  open,
  onOpenChange,
  client,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: Client | null;
  onSubmit: (values: ClientFormValues) => Promise<void>;
}) {
  const t = useTranslations("clients");
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState<string | null>(client?.color ?? null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent title={client ? t("edit") : t("new")} description={t("formHint")}>
          <form
            key={client?.id ?? "new"}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const str = (k: string) => {
                const v = fd.get(k);
                return typeof v === "string" ? v.trim() : "";
              };
              setSaving(true);
              void onSubmit({
                name: str("name"),
                domains: splitList(str("domains")),
                color,
                notes: str("notes") || null,
                verticalTags: str("tags")
                  ? str("tags")
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : [],
              }).finally(() => {
                setSaving(false);
              });
            }}
          >
            <label className="flex flex-col gap-1 text-[13px] text-ink2">
              {t("form.name")}
              <input name="name" required maxLength={120} defaultValue={client?.name ?? ""} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-ink2">
              {t("form.domains")}
              <input
                name="domains"
                defaultValue={client?.domains.join(", ") ?? ""}
                className={field}
              />
              <span className="text-[12px] text-ink3">{t("form.domainsHint")}</span>
            </label>
            <fieldset className="flex flex-col gap-1 text-[13px] text-ink2">
              <legend>{t("form.color")}</legend>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={t(`form.colors.${String(i) as "0"}`)}
                    aria-pressed={color === c}
                    onClick={() => setColor(color === c ? null : c)}
                    style={{ background: c }}
                    className="h-7 w-7 rounded-full border-2 border-transparent aria-pressed:border-ink"
                  />
                ))}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1 text-[13px] text-ink2">
              {t("form.tags")}
              <input
                name="tags"
                defaultValue={client?.verticalTags.join(", ") ?? ""}
                placeholder={t("form.tagsPlaceholder")}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-ink2">
              {t("form.notes")}
              <textarea name="notes" rows={3} maxLength={2000} defaultValue={client?.notes ?? ""} className={field} />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="quiet" onClick={() => onOpenChange(false)}>
                {t("form.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {t("form.save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
