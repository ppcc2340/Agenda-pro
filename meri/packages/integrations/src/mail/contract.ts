import { expect, it } from "vitest";
import { MessageGoneError } from "../errors";
import type { MailProvider } from "./types";

/**
 * Mail connector contract (docs/07, ADR 0008), run against FakeGmail and the live adapter (simulated Gmail):
 * readonly + drafts, metadata without bodies, history cursors, one-recipient replies, and no way to send.
 */
export interface PlantedMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

export interface MailContractSetup {
  mail: MailProvider;
  /** Delivers a message to the mailbox; returns its id and thread. */
  deliver: (message: PlantedMessage) => Promise<{ id: string; threadId: string }>;
}

const message = (n: number): PlantedMessage => ({
  from: `"Ana Pérez" <ana@cliente.test>`,
  to: "yo@acme.test",
  subject: `Contrato ${String(n)}`,
  body: `Hola, te envío el contrato el viernes (${String(n)}).`,
  date: `2026-10-${String(10 + n)}T09:00:00.000Z`,
});

export function mailContract(make: () => Promise<MailContractSetup>): void {
  it("has no way to send mail", async () => {
    const { mail } = await make();
    expect("send" in mail).toBe(false);
    expect("sendDraft" in mail).toBe(false);
  });

  it("lists recent messages, then only new ones through the history cursor", async () => {
    const { mail, deliver } = await make();
    const first = await deliver(message(1));
    const initial = await mail.listMessages({ after: "2026-10-01T00:00:00Z" });
    expect(initial.messageIds).toContain(first.id);
    const { historyId } = await mail.profile();
    const second = await deliver(message(2));
    const page = await mail.listHistory({ cursor: historyId });
    expect(page.fullResyncRequired).toBe(false);
    expect(page.messageIds).toEqual([second.id]);
    const quiet = await mail.listHistory({ cursor: page.nextCursor });
    expect(quiet.messageIds).toEqual([]);
  });

  it("asks for a full resync when the cursor is no longer valid", async () => {
    const { mail } = await make();
    expect(await mail.listHistory({ cursor: "expired" })).toMatchObject({
      fullResyncRequired: true,
      messageIds: [],
    });
  });

  it("reads metadata without the body, and the body only on demand", async () => {
    const { mail, deliver } = await make();
    const { id, threadId } = await deliver(message(3));
    const meta = await mail.getMessageMeta(id);
    expect(meta).toMatchObject({ id, threadId, subject: "Contrato 3", date: "2026-10-13T09:00:00.000Z" });
    expect(meta.from).toContain("ana@cliente.test");
    expect(meta.to).toContain("yo@acme.test");
    expect(meta.snippet.length).toBeLessThanOrEqual(200);
    expect("bodyText" in meta).toBe(false);
    const full = await mail.getMessageFull(id);
    expect(full.bodyText).toContain("te envío el contrato el viernes");
  });

  it("a message that no longer exists is reported as gone, so a sync can skip it (CR-9)", async () => {
    const { mail } = await make();
    await expect(mail.getMessageMeta("gone-123")).rejects.toBeInstanceOf(MessageGoneError);
    await expect(mail.getMessageFull("gone-123")).rejects.toBeInstanceOf(MessageGoneError);
  });

  it("creates an in-thread draft to exactly one recipient", async () => {
    const { mail, deliver } = await make();
    const { id, threadId } = await deliver(message(4));
    const draft = await mail.createDraft({
      threadId,
      inReplyToMessageId: id,
      to: ["ana@cliente.test"],
      subject: "Re: Contrato 4",
      bodyText: "Hola Ana, ¿tienes novedades del contrato?",
    });
    expect(draft.threadId).toBe(threadId);
    await expect(
      mail.createDraft({
        threadId,
        inReplyToMessageId: id,
        to: ["ana@cliente.test", "otro@cliente.test"],
        subject: "Re",
        bodyText: "x",
      }),
    ).rejects.toMatchObject({ kind: "Permanent" });
    await expect(
      mail.createDraft({
        threadId,
        inReplyToMessageId: "missing",
        to: ["ana@cliente.test"],
        subject: "Re",
        bodyText: "x",
      }),
    ).rejects.toMatchObject({ kind: "Permanent" });
  });
}
