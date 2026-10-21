import type { PlantedMessage } from "../mail/contract";
import { SimulatedGoogle } from "./test-server";

interface SimMessage {
  id: string;
  threadId: string;
  historyId: number;
  internalDate: number;
  labelIds: string[];
  snippet: string;
  headers: { name: string; value: string }[];
  /** Raw MIME payload tree as Gmail returns it in `format=full`. */
  payload: Record<string, unknown>;
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/**
 * Stateful Gmail v1 for tests (ADR 0008): profile, history (404 for ids older than the oldest kept), message list
 * with `after:` queries and paging, metadata/full reads (metadataHeaders honoured), and drafts, whose raw RFC 2822
 * text is decoded and kept for assertions. There is no send route: a call to one would be a 404 here, and the
 * adapter refuses it before that.
 */
export class SimulatedGmail extends SimulatedGoogle {
  private history = 1000;
  private counter = 0;
  readonly messages = new Map<string, SimMessage>();
  readonly drafts: { threadId: string; raw: string; decoded: string }[] = [];
  /** History ids at or below this are "too old" (404), like Gmail after about a week. */
  oldestHistoryId = 1000;

  constructor(readonly emailAddress = "yo@acme.test") {
    super();
    const base = "/gmail/v1/users/me";
    this.on("GET", `${base}/profile`, () => ({
      json: { emailAddress: this.emailAddress, historyId: String(this.history) },
    }));
    this.on("GET", `${base}/history`, (req) => {
      const start = Number(req.url.searchParams.get("startHistoryId"));
      if (!Number.isFinite(start) || start < this.oldestHistoryId)
        return { status: 404, json: { error: { code: 404, errors: [{ reason: "notFound" }] } } };
      const records = [...this.messages.values()]
        .filter((m) => m.historyId > start)
        .sort((a, b) => a.historyId - b.historyId)
        .map((m) => ({
          id: String(m.historyId),
          messagesAdded: [{ message: { id: m.id, labelIds: m.labelIds } }],
        }));
      return { json: { history: records, historyId: String(this.history) } };
    });
    this.on("GET", `${base}/messages`, (req) => {
      const after = Number(/after:(\d+)/.exec(req.url.searchParams.get("q") ?? "")?.[1] ?? 0) * 1000;
      const all = [...this.messages.values()]
        .filter((m) => m.internalDate >= after && !m.labelIds.includes("DRAFT"))
        .sort((a, b) => b.internalDate - a.internalDate);
      const offset = Number(req.url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(offset, offset + 2);
      return {
        json: {
          messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
          ...(offset + 2 < all.length ? { nextPageToken: String(offset + 2) } : {}),
        },
      };
    });
    this.on("GET", new RegExp(`^${base}/messages/[^/]+$`), (req) => {
      const m = this.messages.get(decodeURIComponent(req.url.pathname.split("/").pop() ?? ""));
      if (!m) return { status: 404, json: { error: { code: 404, errors: [{ reason: "notFound" }] } } };
      const format = req.url.searchParams.get("format");
      const wanted = req.url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
      const headers =
        format === "metadata" && wanted.length
          ? m.headers.filter((h) => wanted.includes(h.name.toLowerCase()))
          : m.headers;
      const payload = format === "full" ? { ...m.payload, headers } : { headers };
      return {
        json: {
          id: m.id,
          threadId: m.threadId,
          labelIds: m.labelIds,
          snippet: m.snippet,
          internalDate: String(m.internalDate),
          payload,
        },
      };
    });
    this.on("POST", `${base}/drafts`, (req) => {
      const body = JSON.parse(req.body) as { message: { raw: string; threadId: string } };
      const decoded = Buffer.from(body.message.raw, "base64url").toString("utf8");
      this.drafts.push({ threadId: body.message.threadId, raw: body.message.raw, decoded });
      return {
        json: {
          id: `r-${String(++this.counter)}`,
          message: { id: `d${String(this.counter)}`, threadId: body.message.threadId },
        },
      };
    });
  }

  /** Delivers a message as Gmail would store it: multipart/alternative with plain and HTML parts. */
  deliver(
    planted: PlantedMessage,
    extra: { threadId?: string; html?: string } = {},
  ): { id: string; threadId: string } {
    const id = `18f${(++this.counter).toString(16).padStart(6, "0")}`;
    const threadId = extra.threadId ?? id;
    const headers = [
      { name: "From", value: planted.from },
      { name: "To", value: planted.to },
      { name: "Subject", value: planted.subject },
      // The Date header is sender-controlled: deliberately unparseable here, the adapter must use internalDate.
      { name: "Date", value: "not a date" },
      { name: "Message-ID", value: `<${id}@mail.cliente.test>` },
    ];
    this.messages.set(id, {
      id,
      threadId,
      historyId: ++this.history,
      internalDate: Date.parse(planted.date),
      labelIds: ["INBOX"],
      snippet: planted.body.replace(/'/g, "&#39;").slice(0, 200),
      headers,
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
            body: { data: b64(planted.body) },
          },
          { mimeType: "text/html", body: { data: b64(extra.html ?? `<p>${planted.body}</p>`) } },
          {
            mimeType: "application/pdf",
            filename: "contrato.pdf",
            body: { attachmentId: "att-1", size: 1000 },
          },
        ],
      },
    });
    return { id, threadId };
  }
}
