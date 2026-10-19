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
import { LocalKms, type KmsAdapter } from "./kms";

export interface IntegrationsDeps {
  now: () => Date;
}

export interface Integrations {
  ai: AiClient;
  oauth: GoogleOAuth;
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

  return {
    ai,
    oauth,
    billing,
    analytics,
    kms,
    calendarFor(accountEmail) {
      if (modes.google !== "fake") throw notYet("google-calendar");
      let c = fakeCalendars.get(accountEmail);
      if (!c) {
        c = new FakeCalendar({ now: deps.now });
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
