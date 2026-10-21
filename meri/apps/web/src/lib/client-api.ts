"use client";

/** Browser-side API client through the same-origin rewrite (/api/v1 -> API). Adds the CSRF header. */
export interface Problem {
  code: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

export class ClientApiError extends Error {
  override readonly name = "ClientApiError";
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export async function clientApi<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: {
      ...(rest.headers as Record<string, string> | undefined),
      "x-requested-with": "meri",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const problem = (await res
      .json()
      .catch(() => ({ code: "INTERNAL", title: "Error", status: res.status }))) as Problem;
    throw new ClientApiError(problem);
  }
  // 204 No Content (DELETE /v1/account, session revocation…): there is no body to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") return null as T;
  return (await res.json()) as T;
}
