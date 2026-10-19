"use client";

import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { formatDate, formatMinutes } from "@/lib/format";
import { clientColorVar } from "@/lib/plan";
import { idempotencyKey, useApiMutation, useTasks } from "@/lib/hooks/use-api";
import type { Task, TaskStatus } from "@/lib/types";
import { TaskForm, type TaskFormValues } from "./task-form";

const PILL: Record<TaskStatus, "plain" | "sea" | "risk" | "ok" | "sug"> = {
  pending: "plain",
  scheduled: "sea",
  in_progress: "sea",
  blocked: "risk",
  waiting_on_third_party: "plain",
  at_risk: "risk",
  completed: "ok",
};

export function TaskList({
  clients,
  timezone,
  initialClientId = null,
}: {
  clients: { id: string; name: string }[];
  timezone: string;
  /** F-09 AC2: preselected client filter (deep links from search and the client view). */
  initialClientId?: string | null;
}) {
  const t = useTranslations("tasks");
  const tApp = useTranslations("app");
  const locale = useLocale();
  const { toast } = useToast();
  const tasks = useTasks({ includeCompleted: true });
  const [editing, setEditing] = useState<Task | null>(null);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState<string | null>(initialClientId);
  const invalidate = [["tasks"] as const];

  const save = useApiMutation(async ({ id, values }: { id: string | null; values: TaskFormValues }) => {
    const { blockedBy, ...body } = values;
    const task = id
      ? await clientApi<Task>(`/v1/tasks/${id}`, { method: "PATCH", json: body })
      : await clientApi<Task>("/v1/tasks", {
          method: "POST",
          json: body,
          headers: { "idempotency-key": idempotencyKey() },
        });
    await clientApi(`/v1/tasks/${task.id}/dependencies`, { method: "PUT", json: { blockedBy } });
    return task;
  }, invalidate);
  const setStatus = useApiMutation(
    ({ id, status }: { id: string; status: TaskStatus }) =>
      clientApi<Task>(`/v1/tasks/${id}`, { method: "PATCH", json: { status } }),
    invalidate,
  );
  const remove = useApiMutation(
    (id: string) => clientApi(`/v1/tasks/${id}`, { method: "DELETE" }),
    invalidate,
  );

  const items = (tasks.data?.items ?? [])
    .filter((x) => !clientId || x.clientId === clientId)
    .slice()
    .sort(
      (a, b) =>
        Number(a.status === "completed") - Number(b.status === "completed") ||
        a.priority - b.priority ||
        (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"),
    );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-ink2">{t("subtitle")}</p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          {t("new")}
        </Button>
      </div>
      {clients.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {clients.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={clientId === c.id}
              onClick={() => setClientId(clientId === c.id ? null : c.id)}
              style={{ "--cc": clientColorVar(c.id, clients) } as React.CSSProperties}
              className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-raised px-2.5 py-1 text-[13px] aria-pressed:border-[var(--cc)] aria-pressed:bg-[color-mix(in_srgb,var(--cc)_14%,var(--raised))]"
            >
              <i aria-hidden="true" className="h-[9px] w-[9px] rounded-[3px] bg-[var(--cc)]" />
              {c.name}
            </button>
          ))}
          {clientId ? (
            <Button size="sm" variant="quiet" onClick={() => setClientId(null)}>
              {t("clearFilter")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {tasks.isPending ? <p className="py-6 text-ink3">{tApp("loading")}</p> : null}
      {tasks.isError ? (
        <p role="alert" className="py-6 text-risk">
          {tApp("errorBody")}
        </p>
      ) : null}
      {tasks.data && items.length === 0 ? <EmptyState title={t("emptyTitle")} body={t("emptyBody")} /> : null}
      <ul className="divide-y divide-rule border-t border-rule">
        {items.map((task) => {
          const done = task.status === "completed";
          const client = clients.find((c) => c.id === task.clientId);
          return (
            <li key={task.id} id={`task-${task.id}`} className="flex items-start gap-3.5 py-3 target:bg-sea-soft">
              <button
                type="button"
                aria-label={done ? t("actions.reopen") : t("actions.done")}
                aria-pressed={done}
                onClick={() => {
                  setStatus.mutate({ id: task.id, status: done ? "pending" : "completed" });
                  if (!done) toast(t("toasts.completed"));
                }}
                className={
                  done
                    ? "mt-0.5 grid h-5.5 w-5.5 place-items-center rounded-md border-[1.5px] border-sea bg-sea text-on-sea"
                    : "mt-0.5 grid h-5.5 w-5.5 place-items-center rounded-md border-[1.5px] border-ink3 bg-raised text-transparent"
                }
              >
                <Check size={14} aria-hidden="true" />
              </button>
              <div className="min-w-0 flex-1">
                <div className={done ? "font-semibold text-ink3 line-through" : "font-semibold"}>
                  {task.title}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[13px] text-ink2">
                  {client ? <span>{client.name}</span> : null}
                  <Pill variant={PILL[task.status]}>{t(`status.${task.status}`)}</Pill>
                  <span>{t(`priority.${String(task.priority) as "1"}`)}</span>
                  {task.dueAt ? (
                    <span className="num">
                      {t("due", { date: formatDate(task.dueAt, locale, timezone) })}
                    </span>
                  ) : null}
                  {task.estimateMinutes ? (
                    <span className="num">{formatMinutes(task.estimateMinutes, (k, v) => t(k, v))}</span>
                  ) : null}
                  {task.kind === "deep" ? <span>{t("fields.deep")}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  aria-label={t("actions.edit")}
                  onClick={() => {
                    setEditing(task);
                    setOpen(true);
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={t("actions.delete")}
                  onClick={() => {
                    remove.mutate(task.id);
                    toast(t("toasts.deleted"));
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <TaskForm
        open={open}
        onOpenChange={setOpen}
        task={editing}
        tasks={tasks.data?.items ?? []}
        clients={clients}
        onSubmit={async (values) => {
          try {
            await save.mutateAsync({ id: editing?.id ?? null, values });
            toast(editing ? t("toasts.updated") : t("toasts.created"));
            setOpen(false);
          } catch (e) {
            toast(
              e instanceof ClientApiError && e.problem.code === "CONFLICT"
                ? t("toasts.cycle")
                : tApp("errorBody"),
            );
          }
        }}
      />
    </div>
  );
}
