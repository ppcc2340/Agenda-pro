import { renderNotificationEmail } from "@meri/core";
import { ok, run } from "./_shared";

/**
 * Sends one sample digest to SMOKE_EMAIL_TO through the configured notifier (D-113). In fake mode it only records
 * it. Never prints SMTP_URL. Check SPF/DKIM/DMARC on the received message (docs/blockers/email.md).
 */
await run("email", async ({ config, integrations }) => {
  const to = process.env.SMOKE_EMAIL_TO ?? (integrations.notifier.mode === "live" ? "" : "smoke@meri.local");
  if (!to) throw new Error("SMOKE_EMAIL_TO is required in live mode (the address that receives the sample).");
  const appUrl = config.env.APP_URL;
  const rendered = renderNotificationEmail({
    kind: "digest",
    template: "daily.digest",
    params: { blocks: 3, risks: 1, proposals: 2 },
    locale: "es",
    appUrl,
    unsubscribePageUrl: `${appUrl}/correo/baja?t=smoke`,
  });
  await integrations.notifier.send({
    to,
    ...rendered,
    subject: `[smoke] ${rendered.subject}`,
    unsubscribeUrl: `${appUrl}/api/v1/email/unsubscribe?t=smoke`,
    reference: "smoke",
  });
  ok(
    `${integrations.notifier.mode === "live" ? "sent through SMTP" : "recorded by FakeNotifier (fake mode)"} to ${to}`,
  );
});
