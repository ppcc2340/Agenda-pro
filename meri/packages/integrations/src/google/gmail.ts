import { z } from "zod";
import { IntegrationError, MessageGoneError, type HealthReport } from "../errors";
import type {
  DraftInput,
  DraftRef,
  MailHistoryPage,
  MailMessageFull,
  MailMessageMeta,
  MailProvider,
} from "../mail/types";
import type { GoogleAccountRef } from "../oauth/types";
import { GoogleHttp, type GoogleHttpOptions, type GoogleRequest } from "./http";
import { buildDraftRaw, extractBody, messageIds, parseAddresses, type GmailPart } from "./mime";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PAGES = 20;

/**
 * The only Gmail calls this adapter can make (ADR 0008): reading and creating drafts. Anything else — sending a
 * message, sending a draft, modifying labels, deleting — is refused before a request leaves the process.
 */
const ALLOWED = [
  { method: "GET", path: /^\/gmail\/v1\/users\/me\/profile$/ },
  { method: "GET", path: /^\/gmail\/v1\/users\/me\/history$/ },
  { method: "GET", path: /^\/gmail\/v1\/users\/me\/messages$/ },
  { method: "GET", path: /^\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]{1,64}$/ },
  { method: "POST", path: /^\/gmail\/v1\/users\/me\/drafts$/ },
] as const;

/** Headers the prefilter and the follow-up need (docs/05 §3); nothing else is requested. */
const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "Message-ID",
  "References",
] as const;

const Header = z.object({ name: z.string(), value: z.string() });
const Part: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(Header).optional(),
    body: z
      .object({
        data: z.string().optional(),
        attachmentId: z.string().optional(),
        size: z.number().optional(),
      })
      .optional(),
    parts: z.array(Part).optional(),
  }),
);
const Message = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().regex(/^\d+$/).optional(),
  payload: Part.optional(),
});
const Profile = z.object({ emailAddress: z.string(), historyId: z.string() });
const MessageList = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
});
const History = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z
          .array(
            z.object({ message: z.object({ id: z.string(), labelIds: z.array(z.string()).optional() }) }),
          )
          .optional(),
      }),
    )
    .optional(),
  historyId: z.string(),
  nextPageToken: z.string().optional(),
});
const Draft = z.object({ id: z.string(), message: z.object({ threadId: z.string().optional() }).optional() });

/** Gmail snippets are HTML-escaped; decode the few entities they use and cut to the stored maximum. */
const decodeSnippet = (s: string): string =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .slice(0, 200);

const headerOf = (headers: { name: string; value: string }[], name: string): string | undefined =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/**
 * Live Gmail (docs/07, ADR 0008): readonly + compose. Metadata reads ask only for the headers the prefilter uses;
 * full reads return the best text part without attachments; drafts reply in-thread to one counterpart. There is no
 * send method and no allowed route that could send.
 */
export class LiveGmail implements MailProvider {
  readonly provider = "google" as const;
  private readonly http: GoogleHttp;

  constructor(
    private readonly account: GoogleAccountRef,
    options: GoogleHttpOptions = {},
  ) {
    this.http = new GoogleHttp("gmail", options);
  }

  private async call<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: Omit<GoogleRequest, "token">) {
    const method = req.method ?? "GET";
    const path = new URL(req.url).pathname;
    if (!ALLOWED.some((a) => a.method === method && a.path.test(path)))
      throw new IntegrationError("Permanent", "gmail", `refusing Gmail call ${method} ${path}`);
    return this.http.request(schema, { ...req, token: (o) => this.account.accessToken(o) });
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      await this.profile();
      return { provider: "gmail", mode: "live", status: "healthy" };
    } catch (err) {
      const kind = err instanceof IntegrationError ? err.kind : "Transient";
      return {
        provider: "gmail",
        mode: "live",
        status: kind === "AuthExpired" ? "needs_reauth" : "degraded",
        detail: kind,
      };
    }
  }

  async profile(): Promise<{ email: string; historyId: string }> {
    const res = await this.call(Profile, { url: `${BASE}/profile` });
    if (!res.body) throw new IntegrationError("Permanent", "gmail", "empty profile");
    return { email: res.body.emailAddress.toLowerCase(), historyId: res.body.historyId };
  }

  /**
   * New message ids since `cursor` (a Gmail history id, never a page token: it is stored between runs). Reads pages
   * until `maxResults` ids; when it stops early the cursor is the last history record fully read, else the
   * mailbox's current history id. 404 = the history id is too old → full resync.
   */
  async listHistory(input: { cursor: string | null; maxResults?: number }): Promise<MailHistoryPage> {
    if (!input.cursor || !/^\d+$/.test(input.cursor))
      return { messageIds: [], nextCursor: null, fullResyncRequired: true };
    const max = input.maxResults ?? 100;
    const ids: string[] = [];
    let pageToken: string | undefined;
    let lastRecord: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call(History, {
        url: `${BASE}/history`,
        query: { startHistoryId: input.cursor, historyTypes: "messageAdded", maxResults: 500, pageToken },
        allow: [404],
      });
      if (res.status === 404 || !res.body)
        return { messageIds: [], nextCursor: null, fullResyncRequired: true };
      for (const record of res.body.history ?? []) {
        lastRecord = record.id;
        for (const added of record.messagesAdded ?? []) {
          if (added.message.labelIds?.includes("DRAFT")) continue;
          if (!ids.includes(added.message.id)) ids.push(added.message.id);
        }
        if (ids.length >= max) return { messageIds: ids, nextCursor: record.id, fullResyncRequired: false };
      }
      if (!res.body.nextPageToken)
        return { messageIds: ids, nextCursor: res.body.historyId, fullResyncRequired: false };
      pageToken = res.body.nextPageToken;
    }
    // A very long history (draft-heavy mailboxes): stop here and resume from the last record on the next run, never
    // a permanent failure that would block the sync for good.
    return { messageIds: ids, nextCursor: lastRecord ?? input.cursor, fullResyncRequired: false };
  }

  async listMessages(input: { after: string; maxResults?: number }): Promise<{ messageIds: string[] }> {
    const max = input.maxResults ?? 500;
    const afterSeconds = Math.floor(Date.parse(input.after) / 1000);
    if (!Number.isFinite(afterSeconds)) throw new IntegrationError("Permanent", "gmail", "invalid date");
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES && ids.length < max; page++) {
      const res = await this.call(MessageList, {
        url: `${BASE}/messages`,
        query: {
          q: `after:${String(afterSeconds)} -in:drafts`,
          maxResults: Math.min(500, max - ids.length),
          pageToken,
        },
      });
      ids.push(...(res.body?.messages ?? []).map((m) => m.id));
      pageToken = res.body?.nextPageToken;
      if (!pageToken) break;
    }
    return { messageIds: ids.slice(0, max) };
  }

  async getMessageMeta(id: string): Promise<MailMessageMeta> {
    const res = await this.call(Message, {
      url: `${BASE}/messages/${encodeURIComponent(id)}`,
      query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
      allow: [404],
    });
    if (res.status === 404) throw new MessageGoneError("gmail", id);
    return this.meta(res.body, id);
  }

  async getMessageFull(id: string): Promise<MailMessageFull> {
    const res = await this.call(Message, {
      url: `${BASE}/messages/${encodeURIComponent(id)}`,
      query: { format: "full" },
      allow: [404],
    });
    if (res.status === 404) throw new MessageGoneError("gmail", id);
    const meta = this.meta(res.body, id);
    return { ...meta, bodyText: res.body?.payload ? extractBody(res.body.payload) : "" };
  }

  async createDraft(input: DraftInput): Promise<DraftRef> {
    const to = input.to.map((t) => t.trim().toLowerCase());
    if (to.length !== 1)
      throw new IntegrationError("Permanent", "gmail", "a follow-up draft has exactly one recipient");
    // In-Reply-To needs the RFC Message-ID of the original, not Gmail's id.
    const original = await this.call(Message, {
      url: `${BASE}/messages/${encodeURIComponent(input.inReplyToMessageId)}`,
      query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] },
    });
    const headers = original.body?.payload?.headers ?? [];
    const messageId = messageIds(headerOf(headers, "Message-ID"), 1)[0] ?? null;
    const references = [...messageIds(headerOf(headers, "References")), ...(messageId ? [messageId] : [])];
    let raw: string;
    try {
      raw = buildDraftRaw({
        to: to[0] ?? "",
        subject: input.subject,
        bodyText: input.bodyText,
        inReplyTo: messageId,
        references,
      });
    } catch (cause) {
      throw new IntegrationError("Permanent", "gmail", "invalid draft recipient", { cause });
    }
    const res = await this.call(Draft, {
      method: "POST",
      url: `${BASE}/drafts`,
      json: { message: { raw, threadId: input.threadId } },
    });
    if (!res.body) throw new IntegrationError("Permanent", "gmail", "empty draft response");
    return { draftId: res.body.id, threadId: res.body.message?.threadId ?? input.threadId };
  }

  private meta(body: z.infer<typeof Message> | null, id: string): MailMessageMeta {
    if (!body) throw new IntegrationError("Permanent", "gmail", `message ${id} not found`);
    const headers = body.payload?.headers ?? [];
    const kept: Record<string, string> = {};
    for (const name of METADATA_HEADERS) {
      const value = headerOf(headers, name);
      if (value !== undefined) kept[name] = value.slice(0, 2000);
    }
    // internalDate (ms since epoch, set by Gmail) — never the sender-controlled Date header.
    const date = new Date(body.internalDate ? Number(body.internalDate) : 0).toISOString();
    return {
      id: body.id,
      threadId: body.threadId,
      from: (headerOf(headers, "From") ?? "").slice(0, 500),
      to: [...parseAddresses(headerOf(headers, "To")), ...parseAddresses(headerOf(headers, "Cc"))],
      subject: headerOf(headers, "Subject")?.slice(0, 500) ?? null,
      date,
      headers: kept,
      labels: body.labelIds ?? [],
      snippet: decodeSnippet(body.snippet ?? ""),
    };
  }
}
