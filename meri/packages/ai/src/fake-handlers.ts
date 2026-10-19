import type { FakeAiClient } from "@meri/integrations";
import { parseCapture } from "@meri/core";
import type { CaptureProposal } from "./schemas";

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
}
