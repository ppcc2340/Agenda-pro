"use client";

import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { clientApi } from "@/lib/client-api";
import type {
  CalendarEvent,
  IntegrationAccount,
  Notification,
  Page,
  Plan,
  Proposal,
  Task,
} from "@/lib/types";

export const keys = {
  tasks: (params: string) => ["tasks", params] as const,
  proposals: ["proposals"] as const,
  integrations: ["integrations"] as const,
  plan: ["plan"] as const,
  events: (from: string, to: string) => ["events", from, to] as const,
  notifications: ["notifications"] as const,
  audit: ["audit"] as const,
};

/** Current plan (persisted blocks + last run). Polled: the worker replans in the background after each change. */
export function usePlan(range: { from: string; to: string }) {
  return useQuery({
    queryKey: [...keys.plan, range.from, range.to],
    queryFn: () =>
      clientApi<Plan>(`/v1/plan?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    refetchInterval: 15_000,
  });
}

export function useCalendarEvents(range: { from: string; to: string }) {
  return useQuery({
    queryKey: keys.events(range.from, range.to),
    queryFn: () =>
      clientApi<{ items: CalendarEvent[] }>(
        `/v1/calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    refetchInterval: 30_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => clientApi<Page<Notification>>("/v1/notifications?limit=20"),
    refetchInterval: 30_000,
  });
}

export function useTasks(params: { status?: string; includeCompleted?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.includeCompleted) qs.set("includeCompleted", "true");
  qs.set("limit", "200");
  const query = qs.toString();
  return useQuery({
    queryKey: keys.tasks(query),
    queryFn: () => clientApi<Page<Task>>(`/v1/tasks?${query}`),
  });
}

export function useProposals() {
  return useQuery({
    queryKey: keys.proposals,
    queryFn: () => clientApi<Page<Proposal>>("/v1/proposals?status=pending&limit=100"),
  });
}

export function useIntegrations() {
  return useQuery({
    queryKey: keys.integrations,
    queryFn: () => clientApi<{ items: IntegrationAccount[] }>("/v1/integrations"),
  });
}

/** Mutation that invalidates the given query keys and refreshes server components. */
export function useApiMutation<TData, TVars>(
  fn: (vars: TVars) => Promise<TData>,
  invalidate: readonly (readonly unknown[])[],
  options: Omit<UseMutationOptions<TData, Error, TVars>, "mutationFn"> = {},
) {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    ...options,
    onSuccess: async (data, vars, ...rest) => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      router.refresh();
      await options.onSuccess?.(data, vars, ...rest);
    },
  });
}

export const idempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
