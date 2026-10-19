"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { clientApi, ClientApiError } from "@/lib/client-api";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Schema = z
  .object({
    timezone: z.string().min(1),
    workStart: z.string().regex(HHMM),
    workEnd: z.string().regex(HHMM),
    workDays: z.array(z.number().int().min(0).max(6)).min(1, "days"),
    contingencyPct: z.coerce.number().int().min(0).max(60),
  })
  .refine((v) => v.workStart < v.workEnd, { message: "order", path: ["workEnd"] });
type Values = z.infer<typeof Schema>;

export interface OnboardingInitial {
  timezone: string;
  workStart: string;
  workEnd: string;
  workDays: number[];
  contingencyPct: number;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function timezoneOptions(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const all = intl.supportedValuesOf
    ? intl.supportedValuesOf("timeZone")
    : [
        "UTC",
        "Europe/Madrid",
        "America/Santiago",
        "America/Mexico_City",
        "America/Bogota",
        "America/Buenos_Aires",
      ];
  return current && !all.includes(current) ? [current, ...all] : all;
}

/** F-01 onboarding: time zone, working hours and days, contingency. Saves through PUT /v1/preferences. */
export function OnboardingForm({ initial }: { initial: OnboardingInitial }) {
  const t = useTranslations("onboarding");
  const tApp = useTranslations("app");
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const defaultTz = initial.timezone || browserTimezone();
  const tzOptions = useMemo(() => timezoneOptions(defaultTz), [defaultTz]);
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: {
      timezone: defaultTz,
      workStart: initial.workStart,
      workEnd: initial.workEnd,
      workDays: initial.workDays,
      contingencyPct: initial.contingencyPct,
    },
  });
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];

  const onSubmit = form.handleSubmit(async (values) => {
    setStatus("saving");
    try {
      await clientApi("/v1/preferences", { method: "PUT", json: { ...values, completeOnboarding: true } });
      setStatus("saved");
      router.push("/hoy");
      router.refresh();
    } catch (e) {
      setStatus("error");
      if (e instanceof ClientApiError) form.setError("root", { message: e.message });
    }
  });

  const errorText = (code: string | undefined) =>
    code === "order" ? t("errors.order") : code === "days" ? t("errors.days") : code;

  return (
    <form
      onSubmit={(e) => {
        void onSubmit(e);
      }}
      className="mt-6 flex flex-col gap-5"
      noValidate
    >
      <label className="flex flex-col gap-1 font-semibold">
        {t("timezone")}
        <select
          {...form.register("timezone")}
          className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
        >
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 font-semibold">
          {t("workStart")}
          <input
            type="time"
            step={300}
            {...form.register("workStart")}
            className="num rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 font-semibold">
          {t("workEnd")}
          <input
            type="time"
            step={300}
            {...form.register("workEnd")}
            className="num rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
          />
          {form.formState.errors.workEnd ? (
            <span role="alert" className="text-[13px] font-normal text-risk">
              {errorText(form.formState.errors.workEnd.message)}
            </span>
          ) : null}
        </label>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">{t("workDays")}</legend>
        <Controller
          control={form.control}
          name="workDays"
          render={({ field }) => (
            <div className="flex gap-2">
              {dayOrder.map((d) => {
                const on = field.value.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      field.onChange(on ? field.value.filter((x) => x !== d) : [...field.value, d].sort());
                    }}
                    className={
                      on
                        ? "h-10 w-10 rounded-full bg-sea font-semibold text-on-sea"
                        : "h-10 w-10 rounded-full border border-rule bg-raised font-semibold text-ink2"
                    }
                  >
                    {t(`days.${String(d) as "0"}`)}
                  </button>
                );
              })}
            </div>
          )}
        />
        {form.formState.errors.workDays ? (
          <span role="alert" className="text-[13px] text-risk">
            {errorText(form.formState.errors.workDays.message)}
          </span>
        ) : null}
      </fieldset>
      <label className="flex flex-col gap-1 font-semibold">
        {t("contingency")}
        <span className="flex items-center gap-3 font-normal">
          <input
            type="range"
            min={0}
            max={60}
            step={5}
            {...form.register("contingencyPct")}
            className="flex-1"
          />
          <span className="num w-12 text-right">{form.watch("contingencyPct")} %</span>
        </span>
        <span className="text-[13px] font-normal text-ink2">{t("contingencyHelp")}</span>
      </label>
      {form.formState.errors.root ? (
        <p role="alert" className="rounded-lg bg-risk-soft px-3 py-2 text-risk">
          {tApp("errorTitle")}: {form.formState.errors.root.message}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={status === "saving"}>
          {status === "saving" ? t("saving") : t("submit")}
        </Button>
        {status === "saved" ? <span className="text-ok">{t("saved")}</span> : null}
      </div>
    </form>
  );
}
