import type { Instrumentation } from "next";

/**
 * Server-side error reporting (D-118). Node runtime only: the edge middleware has no tracker, and the browser
 * bundle gets no SDK, so the Content-Security-Policy keeps `connect-src 'self'`.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { reportRequestError } = await import("./server/error-reporting");
    reportRequestError(error, {
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
    });
  } catch (err) {
    // Reporting must never mask the original failure, which Next already logs.
    console.error("error reporting unavailable", err instanceof Error ? err.message : "unknown");
  }
};
