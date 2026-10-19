/**
 * AI-3 follow-up draft (docs/05 §2, §6.5): the model writes the body; recipient, subject and threading are set by
 * code from the thread. Never sends.
 */
import { looksLikeInjection } from "@meri/core";
import type { AiClient, AiUsage } from "@meri/integrations";
import { z } from "zod";
import { FOLLOWUP_DRAFT_SYSTEM_PROMPT } from "./prompts/followup-draft";

export const FollowupDraft = z.object({ body: z.string().min(20).max(1500) });
export type FollowupDraft = z.infer<typeof FollowupDraft>;

export interface FollowupInput {
  language: "es" | "en";
  counterpartyName: string | null;
  action: string;
  dueText: string | null;
  dueAt: string | null;
  daysLate: number;
  subject: string | null;
  myName: string | null;
}

export function buildFollowupContext(input: FollowupInput): string {
  const lines = [
    `Language: ${input.language}`,
    `<followup>`,
    `Counterparty: ${input.counterpartyName ?? "(unknown)"}`,
    `Promised: ${input.action}`,
    `Expected: ${input.dueText ?? input.dueAt ?? "(no date)"}`,
    `Days late: ${String(input.daysLate)}`,
    `Thread subject: ${input.subject ?? ""}`,
    `Me: ${input.myName ?? ""}`,
    `</followup>`,
  ];
  return lines.join("\n").replace(/<\/followup>(?![^]*$)/g, "‹tag›");
}

export async function draftFollowup(
  ai: AiClient,
  input: FollowupInput,
): Promise<{ body: string; usage: AiUsage }> {
  const res = await ai.complete({
    operation: "followup_draft",
    model: "smart",
    system: FOLLOWUP_DRAFT_SYSTEM_PROMPT,
    user: buildFollowupContext(input),
    schema: FollowupDraft,
    maxTokens: 600,
  });
  const body = res.output.body.trim();
  if (looksLikeInjection(body) || /https?:\/\//i.test(body)) {
    throw new Error("draft rejected by policy: contains instructions or links");
  }
  return { body, usage: res.usage };
}

/** Template fallback (rules, no AI): used by the fake handler and when the AI budget is exhausted. */
export function templateFollowup(input: FollowupInput): string {
  const name = input.counterpartyName?.split(" ")[0] ?? "";
  const when = input.dueText ?? (input.dueAt ? input.dueAt.slice(0, 10) : null);
  if (input.language === "en") {
    return `Hi ${name},\n\nI'm writing about "${input.action}"${when ? `, which we expected for ${when}` : ""}. Could you send it over, or let me know a new date that works for you? I need it to move forward with the rest of the work.\n\nThanks in advance.`;
  }
  return `Hola ${name},\n\nTe escribo por «${input.action}»${when ? `, que quedamos en tener para ${when}` : ""}. ¿Podrías enviármelo o indicarme una nueva fecha? Lo necesito para avanzar con el resto del trabajo.\n\nGracias de antemano.`;
}
