import type { Logger } from "../logger";
import type { ErrorTracker } from "./index";

/**
 * Error reporting to Sentry over its envelope endpoint (D-118), without the SDK: the SDK instruments `http`,
 * console and request bodies by default, and every one of those can carry personal data. This sends only what is
 * listed here: the error type, a scrubbed message, the stack frames and a short allowlist of ids.
 */

export interface SentryDsn {
  publicKey: string;
  envelopeUrl: string;
}

/** `https://<key>@<host>[/<path>]/<projectId>`; plain http only towards localhost. Returns null when malformed. */
export function parseSentryDsn(dsn: string): SentryDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!url.username || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    publicKey: decodeURIComponent(url.username),
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

/** Context keys that may leave the process: ids and request shape, never content (docs/06 §2). */
export const SENTRY_CONTEXT_ALLOWLIST = [
  "traceId",
  "route",
  "method",
  "statusCode",
  "queue",
  "jobId",
  "attempt",
  "workspaceId",
  "source",
  "digest",
] as const;

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Long opaque strings: tokens, keys, signatures, OAuth codes. Uuids (36 with dashes) are ids and stay.
const OPAQUE = /\b(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)[A-Za-z0-9_\-+/=.]{32,}/g;
const QUERY = /(https?:\/\/[^\s?#]+)\?[^\s#]*/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** Removes emails, credentials and query strings from free text (exception messages). */
export function scrubText(text: string, max = 1_000): string {
  const out = text
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(EMAIL, "[email]")
    .replace(BEARER, "$1 [redacted]")
    .replace(QUERY, "$1?[redacted]")
    .replace(OPAQUE, "[redacted]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

interface StackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8 stack lines to Sentry frames, oldest call first (Sentry's order). */
export function parseStack(stack: string | undefined, maxFrames = 50): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const filename = (m[2] ?? "").replace(/^file:\/\//, "");
    frames.push({
      ...(m[1] ? { function: m[1] } : {}),
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
    if (frames.length >= maxFrames) break;
  }
  return frames.reverse();
}

interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: StackFrame[] };
}

/** The error and up to two causes, outermost last (Sentry's chained-exception order). */
function exceptionValues(error: unknown): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    if (current instanceof Error) {
      const frames = parseStack(current.stack);
      values.push({
        type: current.name || "Error",
        value: scrubText(current.message),
        ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      });
      current = current.cause;
    } else {
      // Thrown non-errors (strings, objects) carry no type; only their kind leaves the process.
      values.push({ type: "NonError", value: `thrown ${typeof current}` });
      current = undefined;
    }
  }
  return values.reverse();
}

function contextTags(context: Record<string, unknown> | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  if (!context) return tags;
  for (const key of SENTRY_CONTEXT_ALLOWLIST) {
    const v = context[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      // Routes are templates (`/v1/tasks/:id`) when Fastify matched one; a raw URL loses its query string.
      tags[key] = scrubText(key === "route" ? (s.split("?")[0] ?? "") : s, 200);
    }
  }
  return tags;
}

export interface SentryTrackerOptions {
  dsn: SentryDsn;
  service: string;
  environment: string;
  release?: string | undefined;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Events per rolling minute per process; beyond it events are dropped and counted. */
  maxPerMinute?: number;
  /** The same error (type, message, top frame) is sent at most once in this window. */
  dedupeMs?: number;
  timeoutMs?: number;
}

export interface SentryErrorTracker extends ErrorTracker {
  /** Events not sent because of the local rate limit, deduplication or Sentry's own Retry-After. */
  readonly dropped: number;
}

/**
 * Fire-and-forget: `captureException` never throws and never waits on the network; `flush` waits for pending
 * sends up to a bound. Every exception is also logged, so the logs stay complete when Sentry drops or fails.
 */
export function createSentryErrorTracker(options: SentryTrackerOptions): SentryErrorTracker {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const dedupeMs = options.dedupeMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pending = new Set<Promise<void>>();
  const sentAt: number[] = [];
  const recent = new Map<string, number>();
  let blockedUntil = 0;
  let dropped = 0;
  const auth = `Sentry sentry_version=7, sentry_key=${options.dsn.publicKey}, sentry_client=meri-tracker/1.0`;

  const admit = (fingerprint: string, t: number): boolean => {
    if (t < blockedUntil) return false;
    while (sentAt.length > 0 && (sentAt[0] ?? 0) <= t - 60_000) sentAt.shift();
    if (sentAt.length >= maxPerMinute) return false;
    for (const [k, at] of recent) if (at <= t - dedupeMs) recent.delete(k);
    if (recent.has(fingerprint)) return false;
    recent.set(fingerprint, t);
    sentAt.push(t);
    return true;
  };

  const send = async (body: string): Promise<void> => {
    try {
      const res = await doFetch(options.dsn.envelopeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        blockedUntil = now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1_000;
      } else if (!res.ok) {
        options.logger.warn({ status: res.status }, "sentry rejected an error event");
      }
    } catch (err) {
      options.logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "sentry delivery failed");
    }
  };

  return {
    get dropped() {
      return dropped;
    },
    captureException(error, context) {
      options.logger.error({ err: error, ...context }, "captured exception");
      try {
        const values = exceptionValues(error);
        const main = values[values.length - 1];
        const top = main?.stacktrace?.frames[main.stacktrace.frames.length - 1];
        const fingerprint = `${main?.type ?? ""}|${main?.value ?? ""}|${top?.filename ?? ""}:${String(top?.lineno ?? "")}`;
        const t = now();
        if (!admit(fingerprint, t)) {
          dropped++;
          return;
        }
        const eventId = globalThis.crypto.randomUUID().replace(/-/g, "");
        const event = {
          event_id: eventId,
          timestamp: t / 1_000,
          platform: "node",
          level: "error",
          logger: options.service,
          environment: options.environment,
          ...(options.release ? { release: options.release } : {}),
          tags: { service: options.service, ...contextTags(context) },
          exception: { values },
        };
        const body = [
          JSON.stringify({ event_id: eventId, sent_at: new Date(t).toISOString() }),
          JSON.stringify({ type: "event" }),
          JSON.stringify(event),
        ].join("\n");
        const p = send(body).finally(() => pending.delete(p));
        pending.add(p);
      } catch (err) {
        // Reporting must never break the caller; the exception itself is already in the logs.
        options.logger.warn(
          { err: err instanceof Error ? err.message : "unknown" },
          "sentry event not built",
        );
      }
    },
    async flush() {
      if (pending.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
