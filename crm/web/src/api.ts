/** Thin fetch client. All calls go to /api with the session cookie. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const res = await fetch(url.startsWith("/") ? url : `/api/${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const d = data as { error?: string; details?: unknown } | null;
    if (res.status === 401 && !url.includes("auth/")) window.dispatchEvent(new CustomEvent("crm:unauthorized"));
    if (res.status === 403 && (d?.details as { code?: string } | undefined)?.code === "mfa_setup_required") window.dispatchEvent(new CustomEvent("crm:mfa-required"));
    throw new ApiError(res.status, d?.error ?? `Error ${res.status}`, d?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function downloadFile(url: string, filename?: string) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "No se pudo descargar");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename ?? res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? "export";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
