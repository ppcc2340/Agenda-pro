import { ok, run } from "./_shared";

await run("observability", async ({ integrations }) => {
  const a = integrations.analytics;
  a.track("integration_error", "smoke-user", { provider: "smoke", count: 1 });
  a.captureError(new Error("smoke test error (no personal data)"));
  await a.flush();
  ok(`one event and one error sent in mode ${a.mode}`);
});
