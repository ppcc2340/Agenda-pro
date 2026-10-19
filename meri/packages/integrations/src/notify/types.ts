/**
 * Outbound notifications (P1-09, D-020). The in-app inbox is always written by the handler; a Notifier additionally
 * delivers a copy (push or transactional email from Meri's own domain, never the user's Gmail). Fake = records only.
 */
export interface OutboundNotification {
  workspaceId: string;
  kind: "digest" | "risk" | "proposals" | "plan" | "integration";
  title: string;
  body: string;
  /** Ids only, never content (docs/09). */
  refs: { type: string; id: string }[];
}

export interface Notifier {
  readonly mode: "fake" | "live";
  deliver(notification: OutboundNotification): Promise<void>;
}

export class FakeNotifier implements Notifier {
  readonly mode = "fake" as const;
  readonly delivered: OutboundNotification[] = [];
  deliver(notification: OutboundNotification): Promise<void> {
    this.delivered.push(notification);
    return Promise.resolve();
  }
}
