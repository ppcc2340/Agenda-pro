import { describe, expect, it } from "vitest";
import { detectFollowups } from "./rules";

const now = "2026-10-19T10:40:00Z";
const base = {
  now,
  me: "Yo <yo@mifirma.example>",
  followupDays: 3,
  mutedEmails: new Set<string>(),
  mutedClientIds: new Set<string>(),
};

describe("detectFollowups (F-08, D-035)", () => {
  it("flags overdue third-party commitments once with the days late, skipping future ones", () => {
    const out = detectFollowups({
      ...base,
      overdue: [
        {
          id: "c1",
          dueAt: "2026-10-16T16:00:00Z",
          counterpartyEmail: "Ana <ana@acme.example>",
          clientId: "acme",
          action: "enviar contrato",
        },
        {
          id: "c2",
          dueAt: "2026-10-21T16:00:00Z",
          counterpartyEmail: "luis@beta.example",
          clientId: null,
          action: "x",
        },
      ],
      unanswered: [],
    });
    expect(out).toEqual([
      expect.objectContaining({
        kind: "overdue_commitment",
        refId: "c1",
        daysLate: 3,
        counterpartyEmail: "ana@acme.example",
        suggestedAction: "draft",
      }),
    ]);
  });

  it("flags sent threads without a reply after followupDays and names the other party", () => {
    const out = detectFollowups({
      ...base,
      overdue: [],
      unanswered: [
        {
          id: "t1",
          lastMessageAt: "2026-10-14T09:00:00Z",
          participants: ["yo@mifirma.example", "ana@acme.example"],
          clientId: "acme",
          subject: "Poder",
        },
        {
          id: "t2",
          lastMessageAt: "2026-10-18T09:00:00Z",
          participants: ["yo@mifirma.example", "x@y.example"],
          clientId: null,
          subject: null,
        },
      ],
    });
    expect(out).toEqual([
      expect.objectContaining({
        kind: "unanswered_thread",
        refId: "t1",
        daysLate: 5,
        counterpartyEmail: "ana@acme.example",
        suggestedAction: "waiting_task",
      }),
    ]);
  });

  it("honours mutes per contact and per client (F-08 AC2)", () => {
    const out = detectFollowups({
      ...base,
      mutedEmails: new Set(["ana@acme.example"]),
      mutedClientIds: new Set(["beta"]),
      overdue: [
        {
          id: "c1",
          dueAt: "2026-10-16T16:00:00Z",
          counterpartyEmail: "ana@acme.example",
          clientId: null,
          action: "a",
        },
        {
          id: "c2",
          dueAt: "2026-10-16T16:00:00Z",
          counterpartyEmail: "luis@beta.example",
          clientId: "beta",
          action: "b",
        },
        {
          id: "c3",
          dueAt: "2026-10-16T16:00:00Z",
          counterpartyEmail: "marta@luna.example",
          clientId: "luna",
          action: "c",
        },
      ],
      unanswered: [
        {
          id: "t1",
          lastMessageAt: "2026-10-10T09:00:00Z",
          participants: ["yo@mifirma.example", "ana@acme.example"],
          clientId: null,
          subject: null,
        },
      ],
    });
    expect(out.map((o) => o.refId)).toEqual(["c3"]);
  });
});
