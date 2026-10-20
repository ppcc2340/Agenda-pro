import type { Analytics, AnalyticsEvent, AnalyticsProps } from "./types";

export interface PostHogOptions {
  apiKey: string;
  host: string;
  fetch?: typeof fetch;
  /** Events buffered before an automatic flush. */
  batchSize?: number;
  now?: () => Date;
  /** Delivery failures are reported here, never thrown into product code (analytics must not break a request). */
  onError?: (error: unknown) => void;
  /** Buffered events leave at least this often even with low traffic (0 disables the timer; default 10 s). */
  flushIntervalMs?: number;
  /** Per-request timeout (default 5 s). */
  timeoutMs?: number;
}

interface Captured {
  event: string;
  distinct_id: string;
  properties: AnalyticsProps;
  timestamp: string;
}

/**
 * Live analytics (docs/09, ADR 0006 [M9]): batches events to PostHog's `/batch/` endpoint. Props are the typed
 * ids-and-counters payloads of `@meri/jobs` analytics; errors are sent as `$exception` with the error class only
 * (messages may carry user data; Sentry receives the full error through the observability module).
 */
export class PostHogAnalytics implements Analytics {
  readonly mode = "live" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private queue: Captured[] = [];
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly options: PostHogOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.batchSize = options.batchSize ?? 20;
    this.now = options.now ?? (() => new Date());
    const every = options.flushIntervalMs ?? 10_000;
    if (every > 0) {
      // Unreferenced: the timer never keeps the process alive; shutdown still flushes explicitly.
      setInterval(() => {
        void this.flush();
      }, every).unref();
    }
  }

  track(event: AnalyticsEvent, distinctId: string, props: AnalyticsProps = {}): void {
    this.enqueue(event, distinctId, props);
  }

  captureError(error: unknown, context: AnalyticsProps = {}): void {
    const type = error instanceof Error ? error.name : typeof error;
    this.enqueue("$exception", "server", { ...context, $exception_type: type });
  }

  private enqueue(event: string, distinctId: string, properties: AnalyticsProps): void {
    this.queue.push({ event, distinct_id: distinctId, properties, timestamp: this.now().toISOString() });
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  /** Sends the buffered events; resolves even when delivery fails (reported through `onError`). */
  flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return this.inFlight;
    this.inFlight = this.inFlight.then(() => this.send(batch));
    return this.inFlight;
  }

  private async send(batch: Captured[]): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.options.host.replace(/\/$/, "")}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.options.apiKey, batch }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      if (!res.ok) throw new Error(`PostHog responded ${String(res.status)}`);
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}
