/**
 * Outbound notifications (P1-09, D-020, D-113). The in-app inbox is always written by the handler; a Notifier
 * delivers an email copy from Meri's own domain, never the user's Gmail. Fake = records only.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** RFC 8058 one-click unsubscribe URL (sent as `List-Unsubscribe` + `List-Unsubscribe-Post`). */
  unsubscribeUrl: string;
  /** The notification id: a header for support, never content. */
  reference: string;
}

export interface Notifier {
  readonly mode: "fake" | "live";
  send(email: OutboundEmail): Promise<void>;
}

export class FakeNotifier implements Notifier {
  readonly mode = "fake" as const;
  readonly sent: OutboundEmail[] = [];
  send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }
}
