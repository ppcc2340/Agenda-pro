import { ok, run } from "./_shared";

await run("stripe", async ({ integrations, config }) => {
  const billing = integrations.billing;
  const health = await billing.healthCheck();
  ok(`billing health: ${health.status} (${health.mode})`);
  if (config.modes.stripe === "fake") {
    const ev = await billing.parseWebhook(JSON.stringify({ id: "evt_smoke", type: "checkout.session.completed", data: {} }), "fake-webhook-secret");
    ok(`webhook signature verified for ${ev.id}`);
    let rejected = false;
    try {
      await billing.parseWebhook("{}", "wrong");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("bad signature was accepted");
    ok("bad signature rejected");
  } else {
    ok("live: prices and webhook signature are verified by the live adapter (phase 4)");
  }
});
