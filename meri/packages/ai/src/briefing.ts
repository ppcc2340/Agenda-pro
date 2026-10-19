/**
 * AI-4 client briefing (F-11, D-043): the model receives ONLY the ContextBuilder payload and returns claims that
 * cite a source id. The policy here discards anything not in the context or carrying instructions; when nothing
 * valid remains (or the model is unavailable / over budget / too slow) the deterministic rules briefing is used.
 */
import { looksLikeInjection, parseClientContext, renderClientContext, type ClientContext, type ContextItem } from "@meri/core";
import type { AiClient, AiUsage } from "@meri/integrations";
import { BRIEFING_SYSTEM_PROMPT } from "./prompts/briefing";
import { Briefing, BRIEFING_SOURCE_TYPES, type BriefingItem } from "./schemas";

export const BRIEFING_TIMEOUT_MS = 8_000;
export const MAX_BRIEFING_ITEMS = 12;

const CITABLE = new Set<string>(BRIEFING_SOURCE_TYPES);

/** Items from a parsed or built context, keyed by id, restricted to citable types. */
const citable = (items: readonly ContextItem[]) => new Map(items.filter((i) => CITABLE.has(i.type)).map((i) => [i.id, i]));

/**
 * Keeps only claims whose source exists in the context with the same type, without instructions, deduplicated
 * by source. Returns the surviving items in the model's order (D-043: 100 % traceable or nothing).
 */
export function applyBriefingPolicy(output: Briefing, items: readonly ContextItem[]): BriefingItem[] {
  const sources = citable(items);
  const seen = new Set<string>();
  const kept: BriefingItem[] = [];
  for (const it of output.items) {
    const src = sources.get(it.sourceId);
    if (!src || src.type !== it.sourceType) continue;
    if (seen.has(it.sourceId)) continue;
    if (looksLikeInjection(it.claim) || /https?:\/\/|\bwww\./i.test(it.claim)) continue;
    seen.add(it.sourceId);
    kept.push({ ...it, claim: it.claim.trim() });
    if (kept.length >= MAX_BRIEFING_ITEMS) break;
  }
  return kept;
}

const fact = (i: ContextItem, k: string) => i.facts[k];
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** Deterministic briefing from the same context: used by the fake handler and as the fallback. */
export function rulesBriefing(items: readonly ContextItem[], now: string): BriefingItem[] {
  const out: BriefingItem[] = [];
  const push = (kind: BriefingItem["kind"], i: ContextItem, claim: string) => {
    if (out.length < MAX_BRIEFING_ITEMS && !out.some((o) => o.sourceId === i.id))
      out.push({ kind, sourceType: i.type as BriefingItem["sourceType"], sourceId: i.id, claim: claim.slice(0, 300) });
  };
  const today = now.slice(0, 10);
  // Risks first: at-risk tasks, overdue commitments, unanswered threads.
  for (const i of items)
    if (i.type === "task" && fact(i, "atRisk") === true) push("risk", i, `Tarea en riesgo: ${i.title}${day(i.date) ? ` (vence ${String(day(i.date))})` : ""}`);
  for (const i of items)
    if (i.type === "commitment" && day(i.date) !== null && String(day(i.date)) < today && fact(i, "status") !== "fulfilled")
      push("risk", i, `${fact(i, "direction") === "owed_to_me" ? "Te deben" : "Debes"} «${i.title}» desde el ${String(day(i.date))}`);
  for (const i of items)
    if (i.type === "thread" && fact(i, "lastMessageFromMe") === true) push("risk", i, `Sin respuesta a tu correo «${i.title}»`);
  // Live commitments.
  for (const i of items)
    if (i.type === "commitment" && fact(i, "status") !== "fulfilled")
      push("commitment", i, `${fact(i, "direction") === "owed_to_me" ? "Te deben" : "Debes"}: ${i.title}${day(i.date) ? ` (${String(day(i.date))})` : ""}`);
  // Pending tasks.
  for (const i of items) if (i.type === "task") push("pending", i, `Pendiente: ${i.title}${day(i.date) ? ` (${String(day(i.date))})` : ""}`);
  // Upcoming meetings count as decisions to prepare; recent threads as communications.
  for (const i of items) if (i.type === "event" && fact(i, "upcoming") === true) push("decision", i, `Reunión: ${i.title} el ${String(day(i.date))}`);
  for (const i of items) if (i.type === "thread") push("communication", i, `Último correo: «${i.title}»${day(i.date) ? ` (${String(day(i.date))})` : ""}`);
  return out;
}

export interface BriefingResult {
  items: BriefingItem[];
  source: "ai" | "rules";
  usage: AiUsage | null;
}

/**
 * Generates the briefing for a built context. Any failure path (timeout, provider error, policy leaves nothing)
 * ends in the rules briefing, so the caller always gets a fully traceable result within the time budget.
 */
export async function generateBriefing(
  ai: AiClient,
  ctx: ClientContext,
  options: { now: string; timeoutMs?: number; useAi: boolean },
): Promise<BriefingResult> {
  if (!options.useAi) return { items: rulesBriefing(ctx.items, options.now), source: "rules", usage: null };
  const user = renderClientContext(ctx, { now: options.now });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("briefing timed out"));
    }, options.timeoutMs ?? BRIEFING_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([
      ai.complete({ operation: "brief_client", model: "smart", system: BRIEFING_SYSTEM_PROMPT, user, schema: Briefing, maxTokens: 1_500 }),
      timeout,
    ]);
    const items = applyBriefingPolicy(res.output, ctx.items);
    if (items.length === 0) return { items: rulesBriefing(ctx.items, options.now), source: "rules", usage: res.usage };
    return { items, source: ai.mode === "live" ? "ai" : "rules", usage: res.usage };
  } catch {
    return { items: rulesBriefing(ctx.items, options.now), source: "rules", usage: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fake handler body: the rules on the parsed payload (the "AI" never knows more than the context). */
export function fakeBriefing(user: string): Briefing {
  const parsed = parseClientContext(user);
  const now = /^Now: (.+)$/m.exec(user)?.[1]?.trim() ?? "1970-01-01";
  return { items: parsed ? rulesBriefing(parsed.items, now) : [] };
}
