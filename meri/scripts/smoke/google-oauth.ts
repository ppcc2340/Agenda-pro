import { ok, run } from "./_shared";

await run("google-oauth", async ({ integrations, config, now }) => {
  const email = "smoke@meri.local";
  const calendar = integrations.calendarFor(email);
  const health = await calendar.healthCheck();
  ok(`calendar health: ${health.status} (${health.mode})`);
  const calendars = await calendar.listCalendars();
  if (calendars.length === 0) throw new Error("no calendars");
  const meriId = await calendar.ensureMeriCalendar();
  const start = new Date(now.getTime() + 3_600_000).toISOString();
  const end = new Date(now.getTime() + 5_400_000).toISOString();
  const ev = await calendar.createMeriEvent(meriId, { title: "Meri smoke test", startsAt: start, endsAt: end });
  await calendar.deleteMeriEvent(meriId, ev.externalId);
  ok(`created and deleted a test event in calendar "${meriId}"`);

  const mail = integrations.mailFor(email);
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
