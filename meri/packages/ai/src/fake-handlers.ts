import type { FakeAiClient } from "@meri/integrations";
import { extractCommitmentsByRules, parseCapture, parseExtractionContext } from "@meri/core";
import { templateFollowup, type FollowupInput } from "./followup";
import type { CaptureProposal, CommitmentExtractionResult } from "./schemas";

/**
 * Deterministic handlers for the fake AI client. They reuse the rules so fake-mode behaviour is honest:
 * the "AI" never knows more than the rules do (docs/blockers/anthropic.md).
 */
export function registerFakeAiHandlers(ai: FakeAiClient): void {
  ai.register("capture.parse", ({ user }) => {
    const now = /Now: (\S+)\./.exec(user)?.[1] ?? "1970-01-01T00:00:00.000Z";
    const timezone = /Time zone: (\S+)\./.exec(user)?.[1] ?? "UTC";
    const clientsRaw = /Clients: (.*)\./.exec(user)?.[1] ?? "";
    const clients =
      clientsRaw === "(none)"
        ? []
        : clientsRaw
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
            .map((name) => ({ id: name, name }));
    const text = /<capture>\n([\s\S]*?)\n<\/capture>/.exec(user)?.[1] ?? "";
    const s = parseCapture(text, { now, timezone, clients });
    const out: CaptureProposal = {
      title: s.title,
      clientName: s.clientName,
      dueAt: s.dueAt,
      estimateMinutes: s.estimateMinutes,
      priority: s.priority,
      kind: s.kind,
    };
    return out;
  });

  // AI-2: the rules extractor runs on the same bounded context the live model would receive.
  ai.register("extract_commitments", ({ user }) => {
    const parsed = parseExtractionContext(user);
    const out: CommitmentExtractionResult = { commitments: [] };
    if (!parsed) return out;
    for (const message of parsed.messages) {
      for (const c of extractCommitmentsByRules(message, {
        me: parsed.me,
        timezone: parsed.timezone,
        now: parsed.now,
      })) {
        if (out.commitments.length >= 10) break;
        out.commitments.push({
          direction: c.direction,
          counterpartyEmail: c.counterpartyEmail,
          action: c.action,
          dueAt: c.dueAt,
          dueText: c.dueText,
          kind: c.kind,
          confidence: c.confidence,
          evidence: c.evidence,
          externalMessageId: c.externalMessageId,
        });
      }
    }
    return out;
  });
  // AI-3: template body; the recipient is never part of the output.
  ai.register("followup_draft", ({ user }) => {
    const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(user)?.[1]?.trim() ?? "";
    const input: FollowupInput = {
      language: get("Language") === "en" ? "en" : "es",
      counterpartyName: get("Counterparty") === "(unknown)" ? null : get("Counterparty"),
      action: get("Promised"),
      dueText: get("Expected") === "(no date)" ? null : get("Expected"),
      dueAt: null,
      daysLate: Number(get("Days late")) || 0,
      subject: get("Thread subject") || null,
      myName: get("Me") || null,
    };
    return { body: templateFollowup(input) };
  });
}
