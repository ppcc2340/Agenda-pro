import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { withWorkspace, type Db, type WorkspaceTx } from "@meri/db";
import { sessionOf } from "./session";

declare module "fastify" {
  interface FastifyRequest {
    /** Run `fn` under the RLS context of the session's workspace (one transaction). */
    withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  }
}

export const contextPlugin = fp<{ db: Db }>((app: FastifyInstance, options, done) => {
  app.decorateRequest("withWorkspace", function withWorkspaceForRequest<
    T,
  >(this: { session: unknown }, fn: (tx: WorkspaceTx) => Promise<T>) {
    const request = this as unknown as Parameters<typeof sessionOf>[0];
    const session = sessionOf(request);
    return withWorkspace(options.db, session.workspaceId, fn);
  });
  done();
});
