"use client";

import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { clientApi, ClientApiError } from "@/lib/client-api";
import type {
  AiUsage,
  CalendarEvent,
  Commitment,
  Contact,
  IntegrationAccount,
  MailExclusion,
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
  commitments: (params: string) => ["commitments", params] as const,
  contacts: ["contacts"] as const,
  exclusions: ["exclusions"] as const,
  aiUsage: ["ai-usage"] as const,
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

/** Pending proposals. Polled: the worker extracts commitments and scans follow-ups in the background. */
export function useProposals() {
  return useQuery({
    queryKey: keys.proposals,
    queryFn: () => clientApi<Page<Proposal>>("/v1/proposals?status=pending&limit=100"),
    refetchInterval: 10_000,
  });
}

export function useCommitments(params: { direction?: string; status?: string; clientId?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.direction) qs.set("direction", params.direction);
  if (params.status) qs.set("status", params.status);
  if (params.clientId) qs.set("clientId", params.clientId);
  qs.set("limit", "200");
  const query = qs.toString();
  return useQuery({
    queryKey: keys.commitments(query),
    queryFn: () => clientApi<Page<Commitment>>(`/v1/commitments?${query}`),
  });
}

export function useContacts() {
  return useQuery({
    queryKey: keys.contacts,
    queryFn: () => clientApi<{ items: Contact[] }>("/v1/contacts"),
  });
}

export function useMailExclusions() {
  return useQuery({
    queryKey: keys.exclusions,
    queryFn: () => clientApi<{ items: MailExclusion[] }>("/v1/mail/exclusions"),
  });
}

export function useAiUsage() {
  return useQuery({ queryKey: keys.aiUsage, queryFn: () => clientApi<AiUsage>("/v1/ai/usage") });
}

export function useIntegrations() {
  return useQuery({
    queryKey: keys.integrations,
    queryFn: () => clientApi<{ items: IntegrationAccount[] }>("/v1/integrations"),
  });
}

/**
 * Mutation that invalidates the given query keys and refreshes server components. Every failure is shown as a
 * toast (docs/11: errors say what happened) unless the caller handles `onError` itself.
 */
export function useApiMutation<TData, TVars>(
  fn: (vars: TVars) => Promise<TData>,
  invalidate: readonly (readonly unknown[])[],
  options: Omit<UseMutationOptions<TData, Error, TVars>, "mutationFn"> = {},
) {
  const qc = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const tApp = useTranslations("app");
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    ...options,
    onError: (error, vars, ...rest) => {
      if (options.onError) return options.onError(error, vars, ...rest);
      toast(
        error instanceof ClientApiError && error.problem.detail ? error.problem.detail : tApp("errorBody"),
      );
    },
    onSuccess: async (data, vars, ...rest) => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      router.refresh();
      await options.onSuccess?.(data, vars, ...rest);
    },
  });
}

export const idempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
