import { z } from "zod";
import type { HealthReport } from "../errors";

/** Minimal message metadata. Bodies are fetched on demand and never persisted (docs/06 §5). */
export const MailMessageMeta = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  date: z.string().datetime({ offset: true }),
  headers: z.record(z.string()).default({}),
  labels: z.array(z.string()).default([]),
  snippet: z.string().max(200),
});
export type MailMessageMeta = z.infer<typeof MailMessageMeta>;

export interface MailMessageFull extends MailMessageMeta {
  /** Plain-text body. Untrusted content: only ever passed to the AI pipeline behind the prompt-injection defence. */
  bodyText: string;
}

export interface MailHistoryPage {
  messageIds: string[];
  nextCursor: string | null;
  fullResyncRequired: boolean;
}

export interface DraftInput {
  threadId: string;
  inReplyToMessageId: string;
  to: string[];
  subject: string;
  bodyText: string;
}

export interface DraftRef {
  draftId: string;
  threadId: string;
}

/**
 * Mail connector (docs/07, docs/06 §1). Scopes: readonly + compose. There is intentionally NO send method:
 * Meri never sends email in the MVP (CLAUDE.md). CI greps for forbidden send calls.
 */
export interface MailProvider {
  readonly provider: "google";
  healthCheck(): Promise<HealthReport>;
  profile(): Promise<{ email: string; historyId: string }>;
  listHistory(input: { cursor: string | null; maxResults?: number }): Promise<MailHistoryPage>;
  /** Initial load (docs/07): message ids newer than `after`, newest first, bounded by `maxResults`. */
  listMessages(input: { after: string; maxResults?: number }): Promise<{ messageIds: string[] }>;
  getMessageMeta(id: string): Promise<MailMessageMeta>;
  getMessageFull(id: string): Promise<MailMessageFull>;
  createDraft(input: DraftInput): Promise<DraftRef>;
}
