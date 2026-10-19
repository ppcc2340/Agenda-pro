"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Task } from "@/lib/types";

export interface TaskFormValues {
  title: string;
  notes: string | null;
  clientId: string | null;
  priority: number;
  kind: "deep" | "shallow";
  dueAt: string | null;
  deadlineType: "soft" | "hard";
  estimateMinutes: number | null;
  tags: string[];
  blockedBy: string[];
}

export interface TaskFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  tasks: Task[];
  clients: { id: string; name: string }[];
  onSubmit: (values: TaskFormValues) => Promise<void>;
}

const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const field = "rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink";

export function TaskForm({ open, onOpenChange, task, tasks, clients, onSubmit }: TaskFormProps) {
  const t = useTranslations("tasks");
  const locale = useLocale();
  const [saving, setSaving] = useState(false);
  const key = task?.id ?? "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent title={task ? t("actions.edit") : t("new")}>
          <form
            key={key}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const str = (k: string) => {
                const v = fd.get(k);
                return typeof v === "string" ? v.trim() : "";
              };
              const due = str("dueAt");
              const values: TaskFormValues = {
                title: str("title"),
                notes: str("notes") || null,
                clientId: str("clientId") || null,
                priority: Number(str("priority") || "3"),
                kind: str("kind") === "deep" ? "deep" : "shallow",
                dueAt: due ? new Date(due).toISOString() : null,
                deadlineType: str("deadlineType") === "hard" ? "hard" : "soft",
                estimateMinutes: str("estimateMinutes") ? Number(str("estimateMinutes")) : null,
                tags: str("tags")
                  ? str("tags")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [],
                blockedBy: fd.getAll("blockedBy").map(String),
              };
              setSaving(true);
              void onSubmit(values).finally(() => {
                setSaving(false);
              });
            }}
          >
            <label className="flex flex-col gap-1 font-semibold">
              {t("fields.title")}
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={task?.title ?? ""}
                className={field}
                autoFocus
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.client")}
                <select name="clientId" defaultValue={task?.clientId ?? ""} className={field}>
                  <option value="">{t("fields.noClient")}</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.priority")}
                <select name="priority" defaultValue={String(task?.priority ?? 3)} className={field}>
                  {(["1", "2", "3", "4"] as const).map((p) => (
                    <option key={p} value={p}>
                      {t(`priority.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.kind")}
                <select name="kind" defaultValue={task?.kind ?? "shallow"} className={field}>
                  <option value="shallow">{t("fields.shallow")}</option>
                  <option value="deep">{t("fields.deep")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.estimate")}
                <input
                  name="estimateMinutes"
                  type="number"
                  min={5}
                  step={5}
                  defaultValue={task?.estimateMinutes ?? ""}
                  className={`num ${field}`}
                />
              </label>
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.dueAt")}
                <input
                  name="dueAt"
                  type="datetime-local"
                  defaultValue={toLocalInput(task?.dueAt ?? null)}
                  className={`num ${field}`}
                  lang={locale}
                />
              </label>
              <label className="flex flex-col gap-1 font-semibold">
                {t("fields.deadlineType")}
                <select name="deadlineType" defaultValue={task?.deadlineType ?? "soft"} className={field}>
                  <option value="soft">{t("fields.soft")}</option>
                  <option value="hard">{t("fields.hard")}</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 font-semibold">
              {t("fields.tags")}
              <input name="tags" defaultValue={task?.tags.join(", ") ?? ""} className={field} />
            </label>
            <label className="flex flex-col gap-1 font-semibold">
              {t("fields.notes")}
              <textarea name="notes" rows={3} defaultValue={task?.notes ?? ""} className={field} />
            </label>
            {tasks.filter((x) => x.id !== task?.id).length > 0 ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="font-semibold">{t("fields.blockedBy")}</legend>
                <div className="flex max-h-32 flex-col gap-1 overflow-auto rounded-lg border border-rule bg-panel p-2">
                  {tasks
                    .filter((x) => x.id !== task?.id && x.status !== "completed")
                    .map((x) => (
                      <label key={x.id} className="flex items-center gap-2 text-[13.5px]">
                        <input
                          type="checkbox"
                          name="blockedBy"
                          value={x.id}
                          defaultChecked={task?.blockedBy.includes(x.id) ?? false}
                        />
                        {x.title}
                      </label>
                    ))}
                </div>
              </fieldset>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {task ? t("actions.save") : t("actions.create")}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
