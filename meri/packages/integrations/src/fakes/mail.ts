import { IntegrationError, type HealthReport } from "../errors";
import type {
  DraftInput,
  DraftRef,
  MailHistoryPage,
  MailMessageFull,
  MailMessageMeta,
  MailProvider,
} from "../mail/types";

export interface FakeMailOptions {
  email: string;
  seedMessages?: MailMessageFull[];
}

/** In-memory Gmail stand-in: metadata-only reads by default, drafts stored locally, no send capability at all. */
export class FakeGmail implements MailProvider {
  readonly provider = "google" as const;
  readonly messages = new Map<string, MailMessageFull>();
  readonly drafts: (DraftRef & DraftInput)[] = [];
  private history: string[] = [];
  private draftCounter = 0;
  readonly email: string;

  constructor(options: FakeMailOptions) {
    this.email = options.email;
    for (const m of options.seedMessages ?? []) this.addMessage(m);
  }

  addMessage(message: MailMessageFull): void {
    this.messages.set(message.id, message);
    this.history.push(message.id);
  }

  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({ provider: "gmail", mode: "fake", status: "healthy", detail: "FakeGmail" });
  }

  profile(): Promise<{ email: string; historyId: string }> {
    return Promise.resolve({ email: this.email, historyId: String(this.history.length) });
  }

  listHistory(input: { cursor: string | null; maxResults?: number }): Promise<MailHistoryPage> {
    const from = input.cursor ? Number(input.cursor) : 0;
    if (Number.isNaN(from) || from > this.history.length) {
      return Promise.resolve({ messageIds: [], nextCursor: null, fullResyncRequired: true });
    }
    const max = input.maxResults ?? 100;
    const ids = this.history.slice(from, from + max);
    return Promise.resolve({
      messageIds: ids,
      nextCursor: String(from + ids.length),
      fullResyncRequired: false,
    });
  }

  listMessages(input: { after: string; maxResults?: number }): Promise<{ messageIds: string[] }> {
    const after = Date.parse(input.after);
    const ids = [...this.messages.values()]
      .filter((m) => Date.parse(m.date) >= after)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, input.maxResults ?? 500)
      .map((m) => m.id);
    return Promise.resolve({ messageIds: ids });
  }

  getMessageMeta(id: string): Promise<MailMessageMeta> {
    const m = this.messages.get(id);
    if (!m) return Promise.reject(this.notFound(id));
    const { bodyText: _body, ...meta } = m;
    return Promise.resolve(meta);
  }

  getMessageFull(id: string): Promise<MailMessageFull> {
    const m = this.messages.get(id);
    return m ? Promise.resolve(m) : Promise.reject(this.notFound(id));
  }

  createDraft(input: DraftInput): Promise<DraftRef> {
    if (!this.messages.has(input.inReplyToMessageId))
      return Promise.reject(this.notFound(input.inReplyToMessageId));
    const ref: DraftRef = { draftId: `fake-draft-${String(++this.draftCounter)}`, threadId: input.threadId };
    this.drafts.push({ ...ref, ...input });
    return Promise.resolve(ref);
  }

  private notFound(id: string): IntegrationError {
    return new IntegrationError("Permanent", "gmail", `message ${id} not found`);
  }
}
