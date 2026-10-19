/**
 * AI-2 pipeline (docs/05 §3): bounded context → structured call → Zod → coherence → verbatim evidence →
 * injection policy → rule-based confidence → dedupe hash. The same code runs for the fake and the live client.
 */
import { createHash } from "node:crypto";
import {
  buildExtractionContext,
  evidenceAppearsIn,
  looksLikeInjection,
  normalizeForMatch,
  emailAddress,
  type ClientRef,
  type MailMessageInput,
} from "@meri/core";
import type { AiClient, AiUsage } from "@meri/integrations";
import { EXTRACT_COMMITMENTS_SYSTEM_PROMPT } from "./prompts/extract-commitments";
import { CommitmentExtractionResult, type CommitmentExtraction } from "./schemas";

export interface ExtractInput {
  me: string;
  now: string;
  timezone: string;
  threadRef: string; // stable id of the thread (dedupe)
  subject: string | null;
  messages: MailMessageInput[]; // sanitised bodies
  client: ClientRef | null;
}

export interface ExtractedCommitment extends CommitmentExtraction {
  dedupeHash: string;
}

export interface ExtractOutcome {
  commitments: ExtractedCommitment[];
  /** Items the model returned that were dropped by the policy layer, with the reason (for evals and logs). */
  rejected: { reason: "evidence" | "injection" | "message" | "date" | "counterparty"; action: string }[];
  usage: AiUsage[];
  context: string;
  escalated: boolean;
}

const COMMITMENT_VERB =
  /\b(envi|mand|entreg|prepar|revis|llam|confirm|firm|pag|agend|respond|contest|present|adjunt|remit|send|deliver|share|review|prepare|call|confirm|sign|pay|schedule|reply|submit|update|get back|circulate|draft|book)/i;
const DATE_HINT =
  /\b(hoy|mañana|manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|\d{1,2}\/\d{1,2}|\d{1,2} de \w+|today|tomorrow|monday|tuesday|wednesday|thursday|friday|week|month|antes del?|before|by |eod|asap)\b/i;
const HEDGE =
  /\b(quiza|quizas|quizá|quizás|tal vez|a lo mejor|podriamos|podríamos|maybe|perhaps|we could|might|sometime|igual|if you like|si te parece)\b/i;

/** Rule-based classification (docs/05 §3.7): the model's `kind` is advisory; rules decide. */
export function classifyKind(
  c: Pick<CommitmentExtraction, "evidence" | "dueAt" | "dueText" | "kind">,
): CommitmentExtraction["kind"] {
  const text = normalizeForMatch(c.evidence);
  if (HEDGE.test(text) || c.kind === "suggested") return "suggested";
  const hasVerb = COMMITMENT_VERB.test(text);
  const hasDate = Boolean(c.dueAt) || Boolean(c.dueText) || DATE_HINT.test(text);
  if (hasVerb && hasDate) return "explicit";
  return "inferred";
}

export function confidenceFor(kind: CommitmentExtraction["kind"], modelConfidence: number): number {
  const base = kind === "explicit" ? 0.9 : kind === "inferred" ? 0.65 : 0.45;
  return Math.round(Math.min(base, Math.max(0.3, modelConfidence)) * 100) / 100;
}

export function dedupeHashFor(
  threadRef: string,
  c: Pick<CommitmentExtraction, "direction" | "action" | "dueAt">,
): string {
  const day = c.dueAt ? c.dueAt.slice(0, 10) : "";
  const action = normalizeForMatch(c.action)
    .split(" ")
    .filter((w) => w.length > 2)
    .sort()
    .join(" ");
  return createHash("sha256")
    .update(`${threadRef}|${c.direction}|${action}|${day}`)
    .digest("hex")
    .slice(0, 32);
}

const ONE_YEAR = 366 * 86_400_000;
const THIRTY_DAYS = 30 * 86_400_000;

export async function extractCommitments(
  ai: AiClient,
  input: ExtractInput,
  options: { escalateToSmart?: boolean } = {},
): Promise<ExtractOutcome> {
  const context = buildExtractionContext({
    me: input.me,
    now: input.now,
    timezone: input.timezone,
    subject: input.subject,
    messages: input.messages,
    client: input.client,
  });
  const usage: AiUsage[] = [];
  let escalated = false;
  let result = await ai.complete({
    operation: "extract_commitments",
    model: "fast",
    system: EXTRACT_COMMITMENTS_SYSTEM_PROMPT,
    user: context,
    schema: CommitmentExtractionResult,
    maxTokens: 1500,
  });
  usage.push(result.usage);
  // docs/05 §2: escalate to the smart model when the fast one is unsure (only meaningful with the live client).
  if (
    options.escalateToSmart &&
    ai.mode === "live" &&
    result.output.commitments.some((c) => c.confidence < 0.6)
  ) {
    escalated = true;
    result = await ai.complete({
      operation: "extract_commitments",
      model: "smart",
      system: EXTRACT_COMMITMENTS_SYSTEM_PROMPT,
      user: context,
      schema: CommitmentExtractionResult,
      maxTokens: 1500,
    });
    usage.push(result.usage);
  }

  const messages = new Map(input.messages.map((m) => [m.id, m]));
  const me = emailAddress(input.me);
  const participants = new Set(input.messages.flatMap((m) => [m.from, ...m.to].map(emailAddress)));
  const nowMs = Date.parse(input.now);
  const commitments: ExtractedCommitment[] = [];
  const rejected: ExtractOutcome["rejected"] = [];
  const seen = new Set<string>();
  for (const raw of result.output.commitments) {
    const source = messages.get(raw.externalMessageId);
    if (!source) {
      rejected.push({ reason: "message", action: raw.action });
      continue;
    }
    if (!evidenceAppearsIn(raw.evidence, source.text)) {
      rejected.push({ reason: "evidence", action: raw.action });
      continue;
    }
    // docs/05 §6.4: a message that carries instruction-like content is hostile as a whole; nothing it says
    // becomes a commitment, even sentences that look innocent on their own.
    if (
      looksLikeInjection(source.text) ||
      looksLikeInjection(raw.action) ||
      looksLikeInjection(raw.evidence) ||
      looksLikeInjection(raw.dueText ?? "")
    ) {
      rejected.push({ reason: "injection", action: raw.action });
      continue;
    }
    if (raw.dueAt) {
      const due = Date.parse(raw.dueAt);
      if (Number.isNaN(due) || due > nowMs + ONE_YEAR || due < nowMs - THIRTY_DAYS) {
        rejected.push({ reason: "date", action: raw.action });
        continue;
      }
    }
    let counterparty = raw.counterpartyEmail ? emailAddress(raw.counterpartyEmail) : null;
    if (counterparty && (counterparty === me || !participants.has(counterparty))) {
      // The model may not introduce addresses: fall back to the message's other party.
      counterparty = [source.from, ...source.to].map(emailAddress).find((a) => a !== me) ?? null;
      if (raw.counterpartyEmail && !participants.has(emailAddress(raw.counterpartyEmail))) {
        rejected.push({ reason: "counterparty", action: raw.action });
        continue;
      }
    }
    const kind = classifyKind(raw);
    const item: ExtractedCommitment = {
      ...raw,
      counterpartyEmail: counterparty,
      kind,
      confidence: confidenceFor(kind, raw.confidence),
      evidence: raw.evidence.slice(0, 200),
      dedupeHash: dedupeHashFor(input.threadRef, {
        direction: raw.direction,
        action: raw.action,
        dueAt: raw.dueAt,
      }),
    };
    if (seen.has(item.dedupeHash)) continue; // same commitment repeated across messages of the thread
    seen.add(item.dedupeHash);
    commitments.push(item);
  }
  return { commitments, rejected, usage, context, escalated };
}
