import { z } from "zod";
import { PreferencesSchema } from "@meri/db";

const Iso = z.string().datetime();
const IsoNull = Iso.nullable();

/**
 * `meri-export/1` (D-055, docs/13): the contract of `GET /v1/account/export`. It doubles as the allow-list: the
 * response serializer strips any key not declared here, so nothing from the integration layer (tokens, key ids,
 * sync cursors, mail bodies, audit payloads) can leak by accident.
 */
export const AccountExportV1 = z.object({
  format: z.literal("meri-export/1"),
  exportedAt: Iso,
  /** Collections cut at the cap (the phase 5 zip job carries everything). */
  truncated: z.array(z.string()),
  user: z.object({ email: z.string(), name: z.string().nullable(), locale: z.string() }),
  workspace: z.object({ name: z.string(), vertical: z.string().nullable() }),
  preferences: PreferencesSchema.extend({ onboardedAt: IsoNull }).nullable(),
  clients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string().nullable(),
      domains: z.array(z.string()),
      notes: z.string().nullable(),
      verticalTags: z.array(z.string()),
      followupsMuted: z.boolean(),
      archivedAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      name: z.string(),
      kind: z.string().nullable(),
      dueAt: IsoNull,
      status: z.string(),
      createdAt: Iso,
    }),
  ),
  contacts: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      email: z.string(),
      name: z.string().nullable(),
      muted: z.boolean(),
      createdAt: Iso,
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      projectId: z.string().nullable(),
      parentId: z.string().nullable(),
      title: z.string(),
      notes: z.string().nullable(),
      status: z.string(),
      kind: z.string(),
      priority: z.number(),
      dueAt: IsoNull,
      deadlineType: z.string(),
      estimateMinutes: z.number().nullable(),
      tags: z.array(z.string()),
      origin: z.string(),
      blockedBy: z.array(z.string()),
      completedAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  commitments: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      direction: z.string(),
      kind: z.string(),
      status: z.string(),
      counterpartyEmail: z.string().nullable(),
      action: z.string(),
      dueAt: IsoNull,
      dueText: z.string().nullable(),
      confidence: z.number().nullable(),
      /** ≤ 200 characters, the quote the user already sees (docs/05 §3.6); never the message body. */
      evidence: z.string().nullable(),
      taskId: z.string().nullable(),
      origin: z.string(),
      createdAt: Iso,
    }),
  ),
  proposals: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      payload: z.record(z.string(), z.unknown()),
      confidence: z.number().nullable(),
      explanation: z.string().nullable(),
      resolution: z.unknown().nullable(),
      resolvedAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  timeEntries: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      projectId: z.string().nullable(),
      taskId: z.string().nullable(),
      day: z.string(),
      minutes: z.number(),
      description: z.string().nullable(),
      status: z.string(),
      sourceType: z.string(),
      approvedAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  calendarEvents: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      startsAt: Iso,
      endsAt: Iso,
      allDay: z.boolean(),
      attendees: z.array(z.string()),
      clientId: z.string().nullable(),
      origin: z.string(),
      busy: z.boolean(),
    }),
  ),
  blocks: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      startsAt: Iso,
      endsAt: Iso,
      pinned: z.boolean(),
      reason: z.array(z.object({ code: z.string(), params: z.record(z.string(), z.unknown()) })),
      planVersion: z.number(),
      completedAt: IsoNull,
    }),
  ),
  notifications: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      body: z.string(),
      day: z.string(),
      readAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  activity: z.array(
    z.object({
      id: z.string(),
      actor: z.string(),
      action: z.string(),
      entityType: z.string().nullable(),
      entityId: z.string().nullable(),
      reason: z.string().nullable(),
      undoneAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  connections: z.array(
    z.object({
      provider: z.string(),
      email: z.string().nullable(),
      status: z.string(),
      scopes: z.array(z.string()),
      lastSyncAt: IsoNull,
      createdAt: Iso,
    }),
  ),
  /** Phase 4: plan state and the cancellation survey (the user's own words, F-16). */
  billing: z.object({
    plan: z.string(),
    status: z.string(),
    cancellationFeedback: z.array(z.object({ reason: z.string(), comment: z.string().nullable(), createdAt: Iso })),
  }),
});
export type AccountExportV1 = z.infer<typeof AccountExportV1>;

