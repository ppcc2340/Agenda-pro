export {
  IntegrationError,
  type IntegrationErrorKind,
  type ConnectionStatus,
  type HealthReport,
} from "./errors";
export * from "./calendar/types";
export * from "./mail/types";
export * from "./ai/types";
export * from "./billing/types";
export * from "./analytics/types";
export { FakeCalendar, type FakeCalendarOptions } from "./fakes/calendar";
export { FakeGmail, type FakeMailOptions } from "./fakes/mail";
export { FakeAiClient, type FakeAiHandler } from "./fakes/ai";
export { FakeBilling } from "./fakes/billing";
export { NoopAnalytics } from "./fakes/analytics";
export { LocalKms, type KmsAdapter } from "./kms";
export { createIntegrations, type Integrations, type IntegrationsDeps } from "./factory";
export * from "./oauth/types";
export { FakeGoogleOAuth } from "./fakes/oauth";
export { FakeNotifier, type Notifier, type OutboundNotification } from "./notify/types";
export {
  GMAIL_SCOPES,
  scopesFor,
  hasGmailScopes,
  hasCalendarScopes,
  type GoogleFeature,
} from "./oauth/scopes";
export { AnthropicAiClient, type AnthropicClientOptions } from "./anthropic/client";
export { parsePrices, costMicroUsd, DEFAULT_PRICES, type ModelPrice } from "./anthropic/prices";
export { zodToJsonSchema } from "./ai/json-schema";
export {
  DEMO_MAIL_THREADS,
  DEMO_MAIL_MESSAGE_COUNT,
  demoMailDate,
  demoMessageId,
  demoThreadId,
  seedDemoMail,
  type DemoMailThread,
} from "./fakes/demo-mail";
