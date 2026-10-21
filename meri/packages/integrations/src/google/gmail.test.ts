import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mailContract } from "../mail/contract";
import type { GoogleAccountRef } from "../oauth/types";
import { LiveGmail } from "./gmail";
import { SimulatedGmail } from "./gmail-simulator";
import { SimulatedGoogle } from "./test-server";
import { buildDraftRaw, extractBody, isPlainAddress, parseAddresses, type GmailPart } from "./mime";

const ref: GoogleAccountRef = { email: "yo@acme.test", accessToken: () => Promise.resolve("token-1") };
const live = (sim = new SimulatedGmail()) => ({ sim, mail: new LiveGmail(ref, { fetch: sim.fetch }) });

describe("LiveGmail contract (simulated Gmail)", () => {
  mailContract(() => {
    const { sim, mail } = live();
    return Promise.resolve({ mail, deliver: (m) => Promise.resolve(sim.deliver(m)) });
  });
});

describe("LiveGmail specifics", () => {
  const planted = {
    from: '"Ana, Pérez" <ana@cliente.test>',
    to: '"Yo" <yo@acme.test>, "Socio" <socio@acme.test>',
    subject: "Contrato",
    body: "Hola, ¿te envío el contrato el viernes? Gracias",
    date: "2026-10-12T09:00:00.000Z",
  };

  it("can only call the read and draft routes; nothing that could send", async () => {
    const { sim, mail } = live();
    const { id, threadId } = sim.deliver(planted);
    await mail.profile();
    await mail.listMessages({ after: "2026-10-01T00:00:00Z" });
    await mail.listHistory({ cursor: "1000" });
    await mail.getMessageMeta(id);
    await mail.getMessageFull(id);
    await mail.createDraft({
      threadId,
      inReplyToMessageId: id,
      to: ["ana@cliente.test"],
      subject: "Re: Contrato",
      bodyText: "x",
    });
    for (const r of sim.requests) {
      expect(r.url.pathname).not.toMatch(/\/send\b/);
      expect(r.method === "GET" || r.url.pathname.endsWith("/drafts")).toBe(true);
    }
    // Even a crafted id cannot reach another route.
    await expect(mail.getMessageMeta("../drafts/send")).rejects.toMatchObject({ kind: "Permanent" });
  });

  it("uses Gmail's internalDate, the address part of each recipient, and asks only for the needed headers", async () => {
    const { sim, mail } = live();
    const { id } = sim.deliver(planted);
    const meta = await mail.getMessageMeta(id);
    expect(meta.date).toBe("2026-10-12T09:00:00.000Z");
    expect(meta.to).toEqual(["yo@acme.test", "socio@acme.test"]);
    expect(meta.snippet).toContain("¿te envío");
    expect(meta.headers["Message-ID"]).toBe(`<${id}@mail.cliente.test>`);
    const req = sim.requests.find((r) => r.url.searchParams.get("format") === "metadata");
    expect(req?.url.searchParams.getAll("metadataHeaders")).toContain("List-Unsubscribe");
  });

  it("returns the plain part, never attachments, and stops the history at the page cap with a resumable cursor", async () => {
    const { sim, mail } = live();
    const { id } = sim.deliver(planted);
    expect((await mail.getMessageFull(id)).bodyText).toBe(planted.body);
    const { historyId } = await mail.profile();
    const ids = [1, 2, 3].map((n) => sim.deliver({ ...planted, subject: `S${String(n)}` }).id);
    const first = await mail.listHistory({ cursor: historyId, maxResults: 2 });
    expect(first.messageIds).toEqual(ids.slice(0, 2));
    const rest = await mail.listHistory({ cursor: first.nextCursor, maxResults: 2 });
    expect(rest.messageIds).toEqual(ids.slice(2));
    // A history id older than Gmail keeps: full resync.
    sim.oldestHistoryId = 5000;
    expect((await mail.listHistory({ cursor: "1001" })).fullResyncRequired).toBe(true);
  });

  it("replies in-thread with the real Message-ID, one recipient and no header injection", async () => {
    const { sim, mail } = live();
    const { id, threadId } = sim.deliver(planted);
    await mail.createDraft({
      threadId,
      inReplyToMessageId: id,
      to: ["ana@cliente.test"],
      subject: "Re: Contrato\r\nBcc: espia@evil.test",
      bodyText: "Hola Ana\r\nBcc: espia@evil.test\r\n\r\n¿Novedades?",
    });
    const draft = sim.drafts[0];
    expect(draft?.threadId).toBe(threadId);
    const [head = ""] = (draft?.decoded ?? "").split("\r\n\r\n");
    expect(head).toContain(`In-Reply-To: <${id}@mail.cliente.test>`);
    expect(head).toContain("To: ana@cliente.test");
    expect(head.split("\r\n").filter((l) => /^bcc:/i.test(l))).toEqual([]);
    expect(head.split("\r\n").filter((l) => /^to:/i.test(l))).toHaveLength(1);
    for (const bad of ['"Ana" <ana@cliente.test>', "a@x.test, b@y.test", "a@x.test\r\nBcc: z@z.test"])
      await expect(
        mail.createDraft({ threadId, inReplyToMessageId: id, to: [bad], subject: "Re", bodyText: "x" }),
      ).rejects.toMatchObject({ kind: "Permanent" });
  });
});

describe("LiveGmail long histories (review L12)", () => {
  it("stops at the page cap with a resumable cursor instead of failing for good", async () => {
    const google = new SimulatedGoogle();
    let n = 0;
    google.on("GET", "/gmail/v1/users/me/history", () => {
      n += 1;
      // Endless pages of drafts only: nothing to index, always another page.
      return {
        json: {
          history: [
            {
              id: String(2000 + n),
              messagesAdded: [{ message: { id: `d${String(n)}`, labelIds: ["DRAFT"] } }],
            },
          ],
          historyId: "9999",
          nextPageToken: `p${String(n)}`,
        },
      };
    });
    const mail = new LiveGmail(ref, { fetch: google.fetch });
    const page = await mail.listHistory({ cursor: "2000" });
    expect(page).toMatchObject({ messageIds: [], fullResyncRequired: false });
    expect(Number(page.nextCursor)).toBeGreaterThan(2000);
  });
});

describe("MIME properties", () => {
  it("a draft always has the same header lines and the body round-trips, whatever subject and body", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 2000 }), (subject, body) => {
        const decoded = Buffer.from(
          buildDraftRaw({
            to: "ana@cliente.test",
            subject,
            bodyText: body,
            inReplyTo: "<a@b>",
            references: ["<a@b>"],
          }),
          "base64url",
        ).toString("utf8");
        const [head = "", ...rest] = decoded.split("\r\n\r\n");
        const names = head
          .split("\r\n")
          .filter((l) => !l.startsWith(" "))
          .map((l) => l.split(":")[0]);
        expect(names).toEqual([
          "To",
          "Subject",
          "In-Reply-To",
          "References",
          "MIME-Version",
          "Content-Type",
          "Content-Transfer-Encoding",
        ]);
        expect(Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(body);
      }),
      { numRuns: 300 },
    );
  });

  it("parsed recipients are always plain addresses", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (header) => {
        for (const a of parseAddresses(header)) expect(isPlainAddress(a)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("body extraction is bounded on deeply nested or hostile payloads", () => {
    let deep: GmailPart = {
      mimeType: "text/plain",
      body: { data: Buffer.from("hondo").toString("base64url") },
    };
    for (let i = 0; i < 50; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(extractBody(deep)).toBe("");
    expect(extractBody({ mimeType: "text/plain", body: { data: "%%%not-base64%%%" } })).toBeTypeOf("string");
    expect(
      extractBody({
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: "text/plain; charset=x-unknown" }],
        body: { data: Buffer.from("hola").toString("base64url") },
      }),
    ).toBe("hola");
  });
});
