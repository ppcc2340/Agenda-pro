import type { Analytics, AnalyticsEvent, AnalyticsProps } from "../analytics/types";

/** No-op analytics used when ANALYTICS_MODE=noop. Records events in memory so tests can assert on them. */
export class NoopAnalytics implements Analytics {
  readonly mode = "noop" as const;
  readonly events: { event: AnalyticsEvent; distinctId: string; props: AnalyticsProps }[] = [];
  readonly errors: unknown[] = [];

  track(event: AnalyticsEvent, distinctId: string, props: AnalyticsProps = {}): void {
    this.events.push({ event, distinctId, props });
  }

  captureError(error: unknown): void {
    this.errors.push(error);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
