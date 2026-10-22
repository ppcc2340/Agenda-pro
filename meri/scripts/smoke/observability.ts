import { createLogger, createSentryErrorTracker, parseSentryDsn } from "@meri/config";
import { ok, run } from "./_shared";

await run("observability", async ({ config, integrations }) => {
  const a = integrations.analytics;
  a.track("integration_error", "smoke-user", { provider: "smoke", count: 1 });
  a.captureError(new Error("smoke test error (no personal data)"));
  await a.flush();
  ok(`one event and one error sent in mode ${a.mode}`);

  // Sentry (D-118): the same tracker the services use, with the response status recorded.
  if (config.modes.analytics !== "live") {
    ok("Sentry skipped (ANALYTICS_MODE is not live)");
    return;
  }
  if (!config.env.SENTRY_DSN) throw new Error("SENTRY_DSN is missing. See docs/blockers/observability.md.");
  const dsn = parseSentryDsn(config.env.SENTRY_DSN);
  if (!dsn) throw new Error("SENTRY_DSN is malformed. See docs/blockers/observability.md.");
  const statuses: number[] = [];
  const tracker = createSentryErrorTracker({
    dsn,
    service: "smoke",
    environment: config.env.APP_ENV ?? config.env.NODE_ENV,
    logger: createLogger({ name: "smoke", level: "warn" }),
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      statuses.push(res.status);
      return res;
    },
  });
  tracker.captureException(new Error("Meri smoke test error (no personal data)"), { source: "smoke" });
  await tracker.flush();
  if (statuses[0] === undefined || statuses[0] >= 300)
    throw new Error(`Sentry did not accept the event (status ${String(statuses[0] ?? "none")}).`);
  ok(`Sentry accepted the test error (status ${String(statuses[0])}); find it under service:smoke`);
});
