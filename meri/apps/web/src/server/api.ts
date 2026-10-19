import { cookies } from "next/headers";
import { getServerConfig } from "./config";

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: unknown,
  ) {
    super(`${String(status)} ${code}`);
  }
}

/** Server-side call to the API forwarding the session cookie (server components and actions). */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { env } = getServerConfig();
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const res = await fetch(`${env.API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: cookieHeader,
      "x-requested-with": "meri",
      "content-type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const problem: unknown = await res.json().catch(() => null);
    const code =
      typeof problem === "object" && problem && "code" in problem && typeof problem.code === "string"
        ? problem.code
        : "INTERNAL";
    throw new ApiRequestError(res.status, code, problem);
  }
  return (await res.json()) as T;
}

export interface Me {
  user: { id: string; email: string; name: string | null; image: string | null; locale: string };
  workspace: { id: string; name: string; vertical: string | null };
  plan: { plan: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null };
  entitlements: { maxClients: number; aiCreditsMonthly: number; retentionDays: number; features: string[] };
  onboarded: boolean;
}

export async function getMe(): Promise<Me | null> {
  try {
    return await apiFetch<Me>("/v1/me");
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) return null;
    throw e;
  }
}
