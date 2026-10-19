/**
 * Contacts, clients (mute only in this phase) and mail exclusions (F-08 AC2, D-036). Full client CRUD is phase 3.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addMailExclusion,
  audit,
  listClients,
  listContacts,
  listMailExclusions,
  removeMailExclusion,
  setClientFollowupsMuted,
  setContactMuted,
  type ContactView,
  type MailExclusionView,
} from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const IdParams = z.object({ id: z.string().uuid() });
const ContactJson = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  email: z.string(),
  name: z.string().nullable(),
  muted: z.boolean(),
  createdAt: z.string().datetime(),
});
const serializeContact = (c: ContactView) => ({ ...c, createdAt: c.createdAt.toISOString() });
const ClientJson = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  domains: z.array(z.string()),
  followupsMuted: z.boolean(),
});
const ExclusionJson = z.object({
  id: z.string(),
  kind: z.enum(["sender", "domain", "label"]),
  value: z.string(),
  createdAt: z.string().datetime(),
});
const serializeExclusion = (e: MailExclusionView) => ({ ...e, createdAt: e.createdAt.toISOString() });

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LABEL = /^[A-Za-z0-9_\-/ ]{1,64}$/;
/** Value validation per kind: an exclusion must be an address, a hostname or a Gmail label. */
export const ExclusionBody = z
  .object({ kind: z.enum(["sender", "domain", "label"]), value: z.string().trim().min(1).max(254) })
  .superRefine((b, ctx) => {
    const ok =
      b.kind === "sender"
        ? z.string().email().safeParse(b.value).success
        : b.kind === "domain"
          ? DOMAIN.test(b.value)
          : LABEL.test(b.value);
    if (!ok) ctx.addIssue({ code: "custom", path: ["value"], message: `Invalid ${b.kind}.` });
  })
  .transform((b) => ({ kind: b.kind, value: b.kind === "label" ? b.value : b.value.toLowerCase() }));

export function contactRoutes(app: FastifyInstance, options: { now: () => Date }, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/contacts",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], response: { 200: z.object({ items: z.array(ContactJson) }) } },
    },
    async (request) => {
      const session = sessionOf(request);
      const items = await request.withWorkspace((tx) => listContacts(tx, session.workspaceId));
      return { items: items.map(serializeContact) };
    },
  );

  r.patch(
    "/v1/contacts/:id",
    {
      preHandler: requireSession,
      schema: {
        tags: ["clients"],
        params: IdParams,
        body: z.object({ muted: z.boolean() }),
        response: { 200: ContactJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const updated = await request.withWorkspace(async (tx) => {
        const c = await setContactMuted(tx, session.workspaceId, request.params.id, request.body.muted);
        if (!c) throw new ApiError("NOT_FOUND", "Contact not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: request.body.muted ? "followups.muted" : "followups.unmuted",
            entityType: "contact",
            entityId: c.id,
            after: { email: c.email },
          },
        );
        return c;
      });
      return serializeContact(updated);
    },
  );

  r.get(
    "/v1/clients",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], response: { 200: z.object({ items: z.array(ClientJson) }) } },
    },
    async (request) => {
      const session = sessionOf(request);
      return { items: await request.withWorkspace((tx) => listClients(tx, session.workspaceId)) };
    },
  );

  r.patch(
    "/v1/clients/:id",
    {
      preHandler: requireSession,
      schema: {
        tags: ["clients"],
        params: IdParams,
        body: z.object({ followupsMuted: z.boolean() }),
        response: { 200: ClientJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      return request.withWorkspace(async (tx) => {
        const ok = await setClientFollowupsMuted(
          tx,
          session.workspaceId,
          request.params.id,
          request.body.followupsMuted,
        );
        if (!ok) throw new ApiError("NOT_FOUND", "Client not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: request.body.followupsMuted ? "followups.muted" : "followups.unmuted",
            entityType: "client",
            entityId: request.params.id,
          },
        );
        const client = (await listClients(tx, session.workspaceId)).find((c) => c.id === request.params.id);
        if (!client) throw new ApiError("NOT_FOUND", "Client not found.");
        return client;
      });
    },
  );

  r.get(
    "/v1/mail/exclusions",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], response: { 200: z.object({ items: z.array(ExclusionJson) }) } },
    },
    async (request) => {
      const session = sessionOf(request);
      const items = await request.withWorkspace((tx) => listMailExclusions(tx, session.workspaceId));
      return { items: items.map(serializeExclusion) };
    },
  );

  r.post(
    "/v1/mail/exclusions",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], body: ExclusionBody, response: { 201: ExclusionJson } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const created = await request.withWorkspace(async (tx) => {
        const e = await addMailExclusion(tx, session.workspaceId, request.body);
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "mail.exclusion_added",
            entityType: "mail_exclusion",
            entityId: e.id,
            after: request.body,
          },
        );
        return e;
      });
      return reply.status(201).send(serializeExclusion(created));
    },
  );

  r.delete(
    "/v1/mail/exclusions/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["integrations"], params: IdParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      await request.withWorkspace(async (tx) => {
        const ok = await removeMailExclusion(tx, session.workspaceId, request.params.id);
        if (!ok) throw new ApiError("NOT_FOUND", "Exclusion not found.");
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          { action: "mail.exclusion_removed", entityType: "mail_exclusion", entityId: request.params.id },
        );
      });
      return reply.status(204).send(null);
    },
  );

  done();
}
