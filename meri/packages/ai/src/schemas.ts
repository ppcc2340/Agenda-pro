import { z } from "zod";

/** AI-2: output of commitment extraction. Validated before anything is persisted. */
export const CommitmentExtraction = z.object({
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  counterpartyEmail: z.string().email().nullable(),
  action: z.string().min(3).max(300),
  dueAt: z.string().datetime().nullable(), // ISO UTC if resolvable
  dueText: z.string().max(120).nullable(), // original phrase, e.g. "el miércoles"
  kind: z.enum(["explicit", "inferred", "suggested"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(3).max(200), // MUST appear verbatim in the source message
  externalMessageId: z.string(),
});
export type CommitmentExtraction = z.infer<typeof CommitmentExtraction>;

export const CommitmentExtractionResult = z.object({
  commitments: z.array(CommitmentExtraction).max(10),
});
export type CommitmentExtractionResult = z.infer<typeof CommitmentExtractionResult>;

/** AI-1: natural-language capture. All fields are SUGGESTIONS until the user confirms. */
export const CaptureProposal = z.object({
  title: z.string().min(1).max(200),
  clientName: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  estimateMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24)
    .nullable(),
  priority: z.number().int().min(1).max(4).nullable(),
  kind: z.enum(["deep", "shallow"]).nullable(),
});
export type CaptureProposal = z.infer<typeof CaptureProposal>;

/** AI-4: briefing. Every statement must cite a source entity. */
export const Briefing = z.object({
  summary: z.string().max(1200),
  items: z
    .array(
      z.object({
        text: z.string().max(400),
        sourceType: z.enum(["task", "commitment", "thread", "event", "document"]),
        sourceId: z.string(),
      }),
    )
    .max(30),
});
export type Briefing = z.infer<typeof Briefing>;
