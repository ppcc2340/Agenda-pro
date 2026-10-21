import type { Fixtures } from "./authz-fixtures";

/**
 * Authorization matrix (P5-06, ADR 0007): EVERY registered route is classified here; `authz-matrix.test.ts` fails
 * when a route is missing. Workspace B calls each tenant route with workspace A's ids (in the path, the body and the
 * query) and must be denied (`denied`) or only ever see its own data (`isolated`). Workspace A's data is compared
 * before and after: nothing may change.
 */
export type Expectation = "denied" | "isolated";
/** Fixture fields that hold one resource id. */
export type IdKey = Exclude<keyof Fixtures, "account" | "cookie" | "secrets">;
export interface AuthzCase {
  /** Path with A's ids (default: the route path with `:id` → the rule's fixture of A). */
  path?: (a: Fixtures, b: Fixtures) => string;
  body?: (a: Fixtures, b: Fixtures) => Record<string, unknown>;
  expect: Expectation;
  /**
   * Why this denial has no positive control (the owner's same request is not expected to succeed). Every other
   * `denied` case is replayed by the owner of the ids, which must get a 2xx.
   */
  noControl?: string;
}
export type AuthzRule =
  /** Not under /v1: probes, webhooks (signed), internal (shared secret), hidden OpenAPI. */
  | { kind: "outside" }
  /** Acts only on the caller's workspace and takes no id: checked for auth/CSRF and isolation. */
  | { kind: "own"; body?: Record<string, unknown>; query?: string; destructive?: true }
  /** Addresses resources by id (path, body or query). */
  | { kind: "tenant"; param?: IdKey; cases: AuthzCase[] };

const denied = (body?: AuthzCase["body"]): AuthzCase => ({ expect: "denied", ...(body ? { body } : {}) });

export const AUTHZ_MATRIX: Record<string, AuthzRule> = {
  "GET /health": { kind: "outside" },
  "GET /ready": { kind: "outside" },
  "GET /docs/json": { kind: "outside" },
  "POST /internal/auth/bootstrap": { kind: "outside" },
  "POST /webhooks/google/calendar": { kind: "outside" },
  "POST /webhooks/google/gmail": { kind: "outside" },
  "POST /webhooks/stripe": { kind: "outside" },

  "GET /v1/me": { kind: "own" },
  "GET /v1/preferences": { kind: "own" },
  "PUT /v1/preferences": { kind: "own", body: { contingencyPct: 15 } },
  "GET /v1/account/export": { kind: "own", query: "format=zip" },
  "POST /v1/account/sessions/revoke": { kind: "own", destructive: true },
  "DELETE /v1/account": { kind: "own", destructive: true },
  "GET /v1/audit": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/audit?limit=50&cursor=${a.audit}`, expect: "isolated" }],
  },
  "POST /v1/audit/:id/undo": { kind: "tenant", param: "audit", cases: [denied()] },

  "GET /v1/tasks": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/tasks?clientId=${a.client}`, expect: "isolated" }],
  },
  "POST /v1/tasks": {
    kind: "tenant",
    cases: [
      denied((a) => ({ title: "x", clientId: a.client })),
      denied((a) => ({ title: "x", projectId: a.project })),
      denied((a) => ({ title: "x", parentId: a.task })),
    ],
  },
  "GET /v1/tasks/:id": { kind: "tenant", param: "task", cases: [denied()] },
  "PATCH /v1/tasks/:id": {
    kind: "tenant",
    param: "task",
    cases: [
      denied(() => ({ title: "hacked" })),
      { path: (_a, b) => `/v1/tasks/${b.task}`, body: (a) => ({ clientId: a.client }), expect: "denied" },
    ],
  },
  "DELETE /v1/tasks/:id": { kind: "tenant", param: "task", cases: [denied()] },
  "PUT /v1/tasks/:id/dependencies": {
    kind: "tenant",
    param: "task",
    cases: [
      denied(() => ({ blockedBy: [] })),
      {
        path: (_a, b) => `/v1/tasks/${b.otherTask}/dependencies`,
        body: (a) => ({ blockedBy: [a.task] }),
        expect: "denied",
      },
    ],
  },

  "GET /v1/integrations": { kind: "own" },
  "POST /v1/integrations/:provider/connect": { kind: "own" },
  "GET /v1/integrations/:provider/callback": {
    kind: "tenant",
    cases: [
      {
        path: () => "/v1/integrations/google/callback?code=fake-code-1&state=x",
        expect: "denied",
        noControl:
          "a forged state is refused for everyone; binding the signed state to its workspace is tested in integrations.test",
      },
    ],
  },
  "POST /v1/integrations/:id/pause": { kind: "tenant", param: "integration", cases: [denied()] },
  "DELETE /v1/integrations/:id": { kind: "tenant", param: "integration", cases: [denied()] },
  "POST /v1/integrations/:id/sync": { kind: "tenant", param: "integration", cases: [denied()] },
  "POST /v1/integrations/:id/mail/sync": { kind: "tenant", param: "integration", cases: [denied()] },
  "GET /v1/calendar/events": {
    kind: "tenant",
    cases: [
      {
        path: (a) =>
          `/v1/calendar/events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&clientId=${a.client}`,
        expect: "isolated",
      },
    ],
  },
  "PATCH /v1/calendar/events/:id": {
    kind: "tenant",
    param: "event",
    cases: [
      denied(() => ({ clientId: null })),
      {
        path: (_a, b) => `/v1/calendar/events/${b.event}`,
        body: (a) => ({ clientId: a.client }),
        expect: "denied",
      },
    ],
  },
  "POST /v1/events/:id/agreements": {
    kind: "tenant",
    param: "event",
    cases: [denied(() => ({ lines: ["Enviar el acta el viernes"] }))],
  },

  "POST /v1/capture": { kind: "own", body: { text: "Llamar a Ana mañana" } },
  "GET /v1/proposals": { kind: "own" },
  "POST /v1/proposals/:id/confirm": { kind: "tenant", param: "proposal", cases: [denied()] },
  "POST /v1/proposals/:id/dismiss": { kind: "tenant", param: "proposal", cases: [denied(() => ({}))] },
  "POST /v1/proposals/confirm-batch": {
    kind: "tenant",
    cases: [{ body: (a) => ({ ids: [a.proposal] }), expect: "isolated" }],
  },

  "GET /v1/plan": { kind: "own" },
  "POST /v1/plan/replan": { kind: "own" },
  "POST /v1/plan/accept": {
    kind: "tenant",
    cases: [
      {
        body: (a) => ({ proposalId: a.proposal }),
        expect: "denied",
        noControl:
          "needs a reschedule diff from a replan; plan.test checks B → 404 then A's own accept → 200",
      },
    ],
  },
  "POST /v1/plan/blocks/:id/pin": {
    kind: "tenant",
    param: "block",
    cases: [denied(() => ({ pinned: true }))],
  },
  "POST /v1/plan/blocks/:id/complete": {
    kind: "tenant",
    param: "block",
    cases: [denied(() => ({ taskDone: true }))],
  },

  "GET /v1/notifications": { kind: "own" },
  "POST /v1/notifications/:id/read": { kind: "tenant", param: "notification", cases: [denied()] },

  "GET /v1/commitments": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/commitments?clientId=${a.client}`, expect: "isolated" }],
  },
  "PATCH /v1/commitments/:id": {
    kind: "tenant",
    param: "commitment",
    cases: [
      denied(() => ({ status: "fulfilled" })),
      {
        path: (_a, b) => `/v1/commitments/${b.commitment}`,
        body: (a) => ({ clientId: a.client }),
        expect: "denied",
      },
    ],
  },
  "POST /v1/commitments/:id/followup-draft": {
    kind: "tenant",
    param: "commitment",
    cases: [denied(() => ({}))],
  },
  "POST /v1/commitments/:id/followup-draft/save": {
    kind: "tenant",
    param: "commitment",
    cases: [
      {
        body: () => ({ body: "Hola, ¿tienes noticias del contrato? Gracias." }),
        expect: "denied",
        noControl:
          "needs an indexed Gmail thread; commitments.test saves the owner's draft (201) and refuses B (404)",
      },
    ],
  },
  "POST /v1/commitments/:id/remind": { kind: "tenant", param: "commitment", cases: [denied(() => ({}))] },
  "GET /v1/ai/usage": { kind: "own" },

  "GET /v1/contacts": { kind: "own" },
  "PATCH /v1/contacts/:id": { kind: "tenant", param: "contact", cases: [denied(() => ({ muted: true }))] },
  "GET /v1/mail/exclusions": { kind: "own" },
  "POST /v1/mail/exclusions": { kind: "own", body: { kind: "domain", value: "own-spam.example" } },
  "DELETE /v1/mail/exclusions/:id": { kind: "tenant", param: "exclusion", cases: [denied()] },

  "GET /v1/clients": { kind: "own" },
  "POST /v1/clients": { kind: "own", body: { name: "Cliente propio" } },
  "GET /v1/clients/:id": { kind: "tenant", param: "client", cases: [denied()] },
  "PATCH /v1/clients/:id": { kind: "tenant", param: "client", cases: [denied(() => ({ name: "hacked" }))] },
  "DELETE /v1/clients/:id": { kind: "tenant", param: "client", cases: [denied()] },
  "GET /v1/clients/:id/briefing": { kind: "tenant", param: "client", cases: [denied()] },
  "POST /v1/clients/:id/briefing": { kind: "tenant", param: "client", cases: [denied(() => ({}))] },
  "GET /v1/projects": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/projects?clientId=${a.client}`, expect: "isolated" }],
  },
  "POST /v1/projects": { kind: "tenant", cases: [denied((a) => ({ clientId: a.client, name: "x" }))] },
  "PATCH /v1/projects/:id": { kind: "tenant", param: "project", cases: [denied(() => ({ name: "hacked" }))] },

  "GET /v1/time-entries": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/time-entries?week=2026-W43&clientId=${a.client}`, expect: "isolated" }],
  },
  "PATCH /v1/time-entries/:id": {
    kind: "tenant",
    param: "timeEntry",
    cases: [denied(() => ({ minutes: 5 }))],
  },
  "POST /v1/time-entries/:id/approve": { kind: "tenant", param: "timeEntry", cases: [denied()] },
  "POST /v1/time-entries/:id/reject": { kind: "tenant", param: "timeEntry", cases: [denied()] },
  "POST /v1/time-entries/approve-batch": {
    kind: "tenant",
    cases: [{ body: (a) => ({ ids: [a.timeEntry] }), expect: "isolated" }],
  },
  "GET /v1/time-entries/export.csv": {
    kind: "tenant",
    cases: [
      {
        path: (a) => `/v1/time-entries/export.csv?week=2026-W43&status=all&clientId=${a.client}`,
        expect: "isolated",
      },
    ],
  },
  "GET /v1/search": {
    kind: "tenant",
    cases: [{ path: (a) => `/v1/search?q=${encodeURIComponent(a.secrets[3] ?? "x")}`, expect: "isolated" }],
  },

  "GET /v1/billing/subscription": { kind: "own" },
  "POST /v1/billing/checkout": { kind: "own", body: { plan: "pro", interval: "month" } },
  "POST /v1/billing/credit-packs": { kind: "own", body: { pack: "500" } },
  "POST /v1/billing/portal": { kind: "own" },
  "POST /v1/billing/cancel": { kind: "own", body: {} },
  "POST /v1/billing/reactivate": { kind: "own" },
  "GET /v1/billing/fake/complete": {
    kind: "tenant",
    cases: [
      {
        path: () => "/v1/billing/fake/complete?session=cs_fake_unknown",
        expect: "denied",
        noControl:
          "an unknown checkout session is refused for everyone; completing one's own checkout is billing.test",
      },
    ],
  },
  "GET /v1/value-report": { kind: "own", query: "period=month" },
  "GET /v1/reviews/daily": { kind: "own", query: "date=2026-10-19" },
  "GET /v1/reviews/weekly": { kind: "own" },
};
