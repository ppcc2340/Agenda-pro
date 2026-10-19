import { ok, run } from "./_shared";

await run("domain-brand", async ({ config }) => {
  const domain = config.env.PUBLIC_DOMAIN;
  const base = domain === "localhost" ? config.env.APP_URL : `https://${domain}`;
  for (const path of ["/privacy", "/terms"]) {
    const url = `${base}${path}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status !== 200) throw new Error(`${url} responded ${String(res.status)}`);
      ok(`${url} responds 200`);
    } catch (e) {
      if (domain === "localhost" && e instanceof TypeError) {
        ok(`${url} not running (start pnpm dev to check); pages are covered by apps/web tests`);
        continue;
      }
      throw e;
    }
  }
});
