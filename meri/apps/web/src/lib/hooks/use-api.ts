"use client";

import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { clientApi } from "@/lib/client-api";
import type { IntegrationAccount, Page, Proposal, Task } from "@/lib/types";

export const keys = {
  tasks: (params: string) => ["tasks", params] as const,
  proposals: ["proposals"] as const,
  integrations: ["integrations"] as const,
};

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
