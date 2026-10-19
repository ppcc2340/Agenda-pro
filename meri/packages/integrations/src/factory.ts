import type { AppConfig } from "@meri/config";
import { IntegrationError } from "./errors";
import type { Analytics } from "./analytics/types";
import type { AiClient } from "./ai/types";
import type { BillingProvider } from "./billing/types";
import type { CalendarProvider } from "./calendar/types";
import type { MailProvider } from "./mail/types";
import { FakeAiClient } from "./fakes/ai";
import { NoopAnalytics } from "./fakes/analytics";
import { FakeBilling } from "./fakes/billing";
import { FakeCalendar } from "./fakes/calendar";
import { FakeGmail } from "./fakes/mail";
import { FakeGoogleOAuth } from "./fakes/oauth";
import type { GoogleOAuth } from "./oauth/types";
import { FakeNotifier, type Notifier } from "./notify/types";
import { LocalKms, type KmsAdapter } from "./kms";

export interface IntegrationsDeps {
  now: () => Date;
}

export interface Integrations {
  ai: AiClient;
  oauth: GoogleOAuth;
  notifier: Notifier;
  billing: BillingProvider;
  analytics: Analytics;
  kms: KmsAdapter;
  /** Per-account connectors are created lazily once an integration account exists (phase 1/2). */
  calendarFor(accountEmail: string): CalendarProvider;
  mailFor(accountEmail: string): MailProvider;
}

const notYet = (name: string) =>
  new IntegrationError(
    "Permanent",
    name,
    `${name} live adapter is implemented in a later phase; use fake mode`,
  );

/**
 * Builds every integration from the resolved modes. Switching fake -> live is configuration only
 * (docs/blockers/README.md): the live branches are filled in by the phase that owns each connector.
 */
export function createIntegrations(config: AppConfig, deps: IntegrationsDeps): Integrations {
  const { modes, env } = config;
  const fakeCalendars = new Map<string, FakeCalendar>();
  const fakeMail = new Map<string, FakeGmail>();

  const ai: AiClient =
    modes.ai === "fake"
      ? new FakeAiClient()
      : (() => {
          throw notYet("anthropic");
        })();
  const oauth: GoogleOAuth =
    modes.google === "fake"
      ? new FakeGoogleOAuth(deps.now)
      : (() => {
          throw notYet("google-oauth");
        })();
  const billing: BillingProvider =
    modes.stripe === "fake"
      ? new FakeBilling(deps.now)
      : (() => {
          throw notYet("stripe");
        })();
  const analytics: Analytics =
    modes.analytics === "fake"
      ? new NoopAnalytics()
      : (() => {
          throw notYet("analytics");
        })();
  const kms: KmsAdapter =
    env.KMS_PROVIDER === "local"
      ? new LocalKms(env.LOCAL_MASTER_KEY ?? "")
      : (() => {
          throw notYet(`kms-${env.KMS_PROVIDER}`);
        })();

  // Live delivery (push / transactional email) is wired in phase 6; the in-app inbox works regardless.
  const notifier: Notifier = new FakeNotifier();
  return {
    ai,
    oauth,
    notifier,
    billing,
    analytics,
    kms,
    calendarFor(accountEmail) {
      if (modes.google !== "fake") throw notYet("google-calendar");
      let c = fakeCalendars.get(accountEmail);
      if (!c) {
        c = new FakeCalendar({ now: deps.now });
        // Sample meetings (D-021) so a connected fake account looks like the demo. Tests seed their own.
        if (!config.isTest) seedSampleMeetings(c, deps.now());
        fakeCalendars.set(accountEmail, c);
      }
      return c;
    },
    mailFor(accountEmail) {
      if (modes.google !== "fake") throw notYet("gmail");
      let m = fakeMail.get(accountEmail);
      if (!m) {
        m = new FakeGmail({ email: accountEmail });
        fakeMail.set(accountEmail, m);
      }
      return m;
    },
  };
}

/** Demo meetings relative to `now`: today's weekly call, tomorrow's strategy meeting, a closing meeting in 3 days. */
export function seedSampleMeetings(calendar: FakeCalendar, now: Date): void {
  const at = (dayOffset: number, hourUtc: number, minute = 0) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    d.setUTCHours(hourUtc, minute, 0, 0);
    return d;
  };
  const iso = (d: Date) => d.toISOString();
  const samples: { title: string; start: Date; minutes: number; attendees: string[] }[] = [
    { title: "Llamada semanal con Acme", start: at(0, 10, 30), minutes: 45, attendees: ["ana@acme.com"] },
    { title: "Reunión de estrategia con Estudio Norte", start: at(1, 14, 30), minutes: 60, attendees: ["laura@estudionorte.cl"] },
    { title: "Reunión de cierre trimestral", start: at(3, 9, 0), minutes: 90, attendees: ["carlos@acme.com", "ana@acme.com"] },
  ];
  for (const s of samples) {
    calendar.addExternalEvent({
      title: s.title,
      startsAt: iso(s.start),
      endsAt: iso(new Date(s.start.getTime() + s.minutes * 60_000)),
      attendees: s.attendees,
    });
  }
}
