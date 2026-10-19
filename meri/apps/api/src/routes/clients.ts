/**
 * Clients and matters (F-09, D-039/D-040): CRUD with the plan's `max_clients`, archive/soft-delete, per-client
 * counters for the Clientes tab, and matters (`projects`). Follow-up mute lives here too (F-08 AC2).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { localDateKey } from "@meri/core";
import {
  audit,
  clientStats,
  countActiveClients,
  createClient,
  createProject,
  getClient,
  getPreferences,
  listClientsFull,
  listProjects,
  relinkClientByDomains,
  softDeleteClient,
  updateClient,
  updateProject,
  type ClientView,
  type ProjectView,
  type WorkspaceTx,
} from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const IdParams = z.object({ id: z.string().uuid() });
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

export const ClientJson = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  domains: z.array(z.string()),
  followupsMuted: z.boolean(),
  notes: z.string().nullable(),
  verticalTags: z.array(z.string()),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  stats: z
    .object({
      openCommitments: z.number(),
      overdueCommitments: z.number(),
      atRiskTasks: z.number(),
      minutesApproved: z.number(),
      minutesSuggested: z.number(),
    })
    .nullable(),
});
const ClientBody = z.object({
  name: z.string().trim().min(1).max(120),
  domains: z.array(z.string().trim().toLowerCase().regex(DOMAIN)).max(20).default([]),
  color: z.string().regex(COLOR).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  verticalTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
const ClientPatch = ClientBody.partial()
  .extend({ followupsMuted: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update." });

const ProjectJson = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  name: z.string(),
  kind: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
});
const ProjectBody = z.object({
  clientId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(160),
  kind: z.string().trim().max(60).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const ProjectPatch = ProjectBody.partial()
  .extend({ status: z.enum(["active", "closed"]).optional() })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update." });

const serializeClient = (c: ClientView, stats: z.infer<typeof ClientJson>["stats"] = null) => ({
  ...c,
  archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
  createdAt: c.createdAt.toISOString(),
  stats,
});
const serializeProject = (p: ProjectView) => ({
  ...p,
  dueAt: p.dueAt ? p.dueAt.toISOString() : null,
  createdAt: p.createdAt.toISOString(),
});

export interface ClientRoutesOptions {
  now: () => Date;
  /** Plan ceiling on active clients (docs/08); entitlements row may override per workspace. */
  maxClientsFor: (tx: WorkspaceTx, workspaceId: Parameters<typeof getClient>[1]) => Promise<number>;
}

export function clientRoutes(app: FastifyInstance, options: ClientRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const actor = (request: Parameters<typeof sessionOf>[0]) => {
    const session = sessionOf(request);
    return { workspaceId: session.workspaceId, actor: "user" as const, actorUserId: session.userId };
  };

  r.get(
    "/v1/clients",
    {
      preHandler: requireSession,
      schema: {
        tags: ["clients"],
        querystring: z.object({
          stats: z.enum(["true", "false"]).optional(),
          includeArchived: z.enum(["true", "false"]).optional(),
        }),
        response: { 200: z.object({ items: z.array(ClientJson) }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      return request.withWorkspace(async (tx) => {
        const items = await listClientsFull(tx, session.workspaceId, {
          includeArchived: request.query.includeArchived === "true",
        });
        if (request.query.stats !== "true") return { items: items.map((c) => serializeClient(c)) };
        const tz = (await getPreferences(tx, session.workspaceId))?.timezone ?? "UTC";
        const today = localDateKey(now.getTime(), tz);
        const monday = new Date(`${today}T00:00:00Z`);
        monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
        const sunday = new Date(monday.getTime() + 6 * 86_400_000);
        const stats = await clientStats(tx, session.workspaceId, {
          from: monday.toISOString().slice(0, 10),
          to: sunday.toISOString().slice(0, 10),
        });
        return {
          items: items.map((c) => {
            const s = stats.get(c.id);
            return serializeClient(
              c,
              s
                ? {
                    openCommitments: s.openCommitments,
                    overdueCommitments: s.overdueCommitments,
                    atRiskTasks: s.atRiskTasks,
                    minutesApproved: s.minutesApproved,
                    minutesSuggested: s.minutesSuggested,
                  }
                : null,
            );
          }),
        };
      });
    },
  );

  r.get(
    "/v1/clients/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], params: IdParams, response: { 200: ClientJson } },
    },
    async (request) => {
      const session = sessionOf(request);
      const client = await request.withWorkspace((tx) =>
        getClient(tx, session.workspaceId, request.params.id),
      );
      if (!client) throw new ApiError("NOT_FOUND", "Client not found.");
      return serializeClient(client);
    },
  );

  r.post(
    "/v1/clients",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], body: ClientBody, response: { 201: ClientJson } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const created = await request.withWorkspace(async (tx) => {
        const max = await options.maxClientsFor(tx, session.workspaceId);
        if ((await countActiveClients(tx, session.workspaceId)) >= max)
          throw new ApiError(
            "ENTITLEMENT_REQUIRED",
            `Your plan allows ${String(max)} active clients. Archive one or upgrade.`,
          );
        const client = await createClient(tx, session.workspaceId, request.body, now);
        if (client.domains.length) await relinkClientByDomains(tx, session.workspaceId, client.id, client.domains);
        await audit(tx, actor(request), {
          action: "client.created",
          entityType: "client",
          entityId: client.id,
          after: { name: client.name, domains: client.domains },
        });
        return client;
      });
      return reply.status(201).send(serializeClient(created));
    },
  );

  r.patch(
    "/v1/clients/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], params: IdParams, body: ClientPatch, response: { 200: ClientJson } },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const b = request.body;
      const updated = await request.withWorkspace(async (tx) => {
        const before = await getClient(tx, session.workspaceId, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Client not found.");
        if (b.archived === false && before.archivedAt) {
          const max = await options.maxClientsFor(tx, session.workspaceId);
          if ((await countActiveClients(tx, session.workspaceId)) >= max)
            throw new ApiError("ENTITLEMENT_REQUIRED", `Your plan allows ${String(max)} active clients.`);
        }
        const client = await updateClient(tx, session.workspaceId, before.id, b, now);
        if (!client) throw new ApiError("NOT_FOUND", "Client not found.");
        const added = client.domains.filter((d) => !before.domains.includes(d));
        if (added.length) await relinkClientByDomains(tx, session.workspaceId, client.id, added);
        await audit(tx, actor(request), {
          action:
            b.followupsMuted !== undefined && Object.keys(b).length === 1
              ? b.followupsMuted
                ? "followups.muted"
                : "followups.unmuted"
              : b.archived !== undefined
                ? b.archived
                  ? "client.archived"
                  : "client.restored"
                : "client.updated",
          entityType: "client",
          entityId: client.id,
          before: { name: before.name, domains: before.domains, followupsMuted: before.followupsMuted },
          after: { name: client.name, domains: client.domains, followupsMuted: client.followupsMuted },
        });
        return client;
      });
      return serializeClient(updated);
    },
  );

  r.delete(
    "/v1/clients/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], params: IdParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      await request.withWorkspace(async (tx) => {
        const before = await getClient(tx, session.workspaceId, request.params.id);
        if (!before) throw new ApiError("NOT_FOUND", "Client not found.");
        await softDeleteClient(tx, session.workspaceId, before.id, now);
        await audit(tx, actor(request), {
          action: "client.deleted",
          entityType: "client",
          entityId: before.id,
          before: { name: before.name },
        });
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/v1/projects",
    {
      preHandler: requireSession,
      schema: {
        tags: ["clients"],
        querystring: z.object({ clientId: z.string().uuid().optional() }),
        response: { 200: z.object({ items: z.array(ProjectJson) }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const items = await request.withWorkspace((tx) =>
        listProjects(tx, session.workspaceId, { clientId: request.query.clientId }),
      );
      return { items: items.map(serializeProject) };
    },
  );

  r.post(
    "/v1/projects",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], body: ProjectBody, response: { 201: ProjectJson } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const b = request.body;
      const created = await request.withWorkspace(async (tx) => {
        if (b.clientId && !(await getClient(tx, session.workspaceId, b.clientId)))
          throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
            { path: "clientId", message: "Unknown client." },
          ]);
        const project = await createProject(
          tx,
          session.workspaceId,
          {
            clientId: b.clientId,
            name: b.name,
            kind: b.kind ?? null,
            dueAt: b.dueAt ? new Date(b.dueAt) : null,
          },
          now,
        );
        await audit(tx, actor(request), {
          action: "project.created",
          entityType: "project",
          entityId: project.id,
          after: { name: project.name, clientId: project.clientId },
        });
        return project;
      });
      return reply.status(201).send(serializeProject(created));
    },
  );

  r.patch(
    "/v1/projects/:id",
    {
      preHandler: requireSession,
      schema: { tags: ["clients"], params: IdParams, body: ProjectPatch, response: { 200: ProjectJson } },
    },
    async (request) => {
      const session = sessionOf(request);
      const b = request.body;
      const updated = await request.withWorkspace(async (tx) => {
        if (b.clientId && !(await getClient(tx, session.workspaceId, b.clientId)))
          throw new ApiError("VALIDATION_FAILED", "Invalid references.", [
            { path: "clientId", message: "Unknown client." },
          ]);
        const project = await updateProject(tx, session.workspaceId, request.params.id, {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.kind !== undefined ? { kind: b.kind } : {}),
          ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
          ...(b.status !== undefined ? { status: b.status } : {}),
          ...(b.clientId !== undefined ? { clientId: b.clientId } : {}),
        });
        if (!project) throw new ApiError("NOT_FOUND", "Project not found.");
        await audit(tx, actor(request), {
          action: "project.updated",
          entityType: "project",
          entityId: project.id,
          after: { name: project.name, status: project.status },
        });
        return project;
      });
      return serializeProject(updated);
    },
  );

  done();
}
