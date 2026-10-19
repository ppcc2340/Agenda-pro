"use client";

import { VERTICALS, VERTICAL_TEMPLATES, type VerticalId } from "@meri/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { keys, useApiMutation } from "@/lib/hooks/use-api";

/** Three radio cards; applying a template changes suggestions only (tags, matter kinds, parser vocabulary). */
export function VerticalCards({
  value,
  onChange,
  disabled = false,
  name = "vertical",
}: {
  value: VerticalId;
  onChange: (v: VerticalId) => void;
  disabled?: boolean;
  name?: string;
}) {
  const t = useTranslations("verticals");
  return (
    <div role="radiogroup" aria-label={t("label")} className="grid gap-2 sm:grid-cols-3">
      {VERTICALS.map((id) => {
        const on = value === id;
        return (
          <label
            key={id}
            className={
              on
                ? "flex cursor-pointer flex-col gap-1 rounded-2xl border-2 border-sea bg-sea-soft px-4 py-3"
                : "flex cursor-pointer flex-col gap-1 rounded-2xl border border-rule bg-raised px-4 py-3 hover:border-sea"
            }
          >
            <input
              type="radio"
              name={name}
              value={id}
              checked={on}
              disabled={disabled}
              onChange={() => onChange(id)}
              className="sr-only"
            />
            <span className="font-head text-[16px] font-semibold">{t(`${id}.name`)}</span>
            <span className="text-[13px] text-ink2">{t(`${id}.desc`)}</span>
            <span className="mt-1 flex flex-wrap gap-1">
              {VERTICAL_TEMPLATES[id].tags.slice(0, 4).map((tag) => (
                <Pill key={tag} variant="plain">
                  {tag}
                </Pill>
              ))}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Control centre panel (D-045): change the vertical; nothing is deleted. */
export function VerticalSettings({ vertical }: { vertical: VerticalId }) {
  const t = useTranslations("control.vertical");
  const { toast } = useToast();
  const [value, setValue] = useState<VerticalId>(vertical);
  useEffect(() => setValue(vertical), [vertical]);
  const save = useApiMutation(
    (v: VerticalId) => clientApi("/v1/preferences", { method: "PUT", json: { vertical: v } }),
    [keys.audit],
    { onSuccess: () => toast(t("saved")), onError: () => setValue(vertical) },
  );
  const tpl = VERTICAL_TEMPLATES[value];
  return (
    <div className="grid gap-3">
      <VerticalCards
        value={value}
        disabled={save.isPending}
        onChange={(v) => {
          setValue(v);
          save.mutate(v);
        }}
      />
      <dl className="grid gap-x-6 gap-y-1 text-[13px] md:grid-cols-[auto_1fr]">
        <dt className="text-ink2">{t("matterKinds")}</dt>
        <dd>{tpl.matterKinds.join(" · ")}</dd>
        <dt className="text-ink2">{t("deadlineNouns")}</dt>
        <dd>{t("sample", { words: tpl.vocabulary.deadlineNouns.slice(0, 8).join(", ") })}</dd>
        <dt className="text-ink2">{t("deliverableNouns")}</dt>
        <dd>{t("sample", { words: tpl.vocabulary.deliverableNouns.slice(0, 8).join(", ") })}</dd>
      </dl>
      <p className="text-[12.5px] text-ink3">{t("note")}</p>
    </div>
  );
}
