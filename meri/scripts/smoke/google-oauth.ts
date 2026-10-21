import { hasForbiddenScope, type GoogleAccountRef } from "@meri/integrations";
import { ok, run, type SmokeContext } from "./_shared";

/**
 * In `live` the adapters need a connection (ADR 0008): the person running the smoke test supplies a refresh token of
 * their own test account through the environment (`SMOKE_GOOGLE_REFRESH_TOKEN`, `SMOKE_GOOGLE_EMAIL`); it is
 * exchanged for an access token here and never printed. In `fake` a bare email is enough.
 */
async function account({ integrations, config }: SmokeContext): Promise<GoogleAccountRef | string> {
  if (config.modes.google === "fake") return "smoke@meri.local";
  const refreshToken = process.env.SMOKE_GOOGLE_REFRESH_TOKEN;
  const email = process.env.SMOKE_GOOGLE_EMAIL;
  if (!refreshToken || !email)
    throw new Error(
      "live smoke needs SMOKE_GOOGLE_REFRESH_TOKEN and SMOKE_GOOGLE_EMAIL (docs/blockers/google-oauth.md)",
    );
  const first = await integrations.oauth.refresh(refreshToken);
  if (first.scopes && hasForbiddenScope(first.scopes)) throw new Error("the grant carries a forbidden scope");
  let current = first.accessToken;
  return {
    email,
    accessToken: async (options) => {
      if (options?.forceRefresh) current = (await integrations.oauth.refresh(refreshToken)).accessToken;
      return current;
    },
  };
}

await run("google-oauth", async (ctx) => {
  const { integrations, config, now } = ctx;
  const ref = await account(ctx);
  const email = typeof ref === "string" ? ref : ref.email;
  const calendar = integrations.calendarFor(ref);
  const health = await calendar.healthCheck();
  ok(`calendar health: ${health.status} (${health.mode})`);
  const calendars = await calendar.listCalendars();
  if (calendars.length === 0) throw new Error("no calendars");
  const meriId = await calendar.ensureMeriCalendar();
  const start = new Date(now.getTime() + 3_600_000).toISOString();
  const end = new Date(now.getTime() + 5_400_000).toISOString();
  const ev = await calendar.createMeriEvent(meriId, {
    title: "Meri smoke test",
    startsAt: start,
    endsAt: end,
  });
  await calendar.deleteMeriEvent(meriId, ev.externalId);
  ok(`created and deleted a test event in calendar "${meriId}"`);

  const mail = integrations.mailFor(ref);
  if (config.modes.google === "fake" && "addMessage" in mail) {
    (mail as { addMessage: (m: unknown) => void }).addMessage({
      id: "smoke-1",
      threadId: "t-smoke",
      from: "ana@acme.com",
      to: [email],
      subject: "Smoke",
      date: now.toISOString(),
      headers: {},
      labels: ["INBOX"],
      snippet: "smoke",
      bodyText: "smoke body",
    });
  }
  const profile = await mail.profile();
  ok(`gmail profile for ${profile.email.replace(/^(.).*(@.*)$/, "$1***$2")}`);
  const page = await mail.listHistory({ cursor: null, maxResults: 1 });
  if (page.messageIds[0]) {
    const meta = await mail.getMessageMeta(page.messageIds[0]);
    ok(`read 1 message as metadata only (thread ${meta.threadId})`);
  } else {
    ok("mailbox empty: nothing to read");
  }
  ok("no draft created, nothing sent");
});
