/**
 * Closed beta (D-099): `POST /v1/waitlist` (public) and `POST /v1/feedback` (session). Neither sends anything to
 * analytics or to the AI; the waitlist answers the same whether or not the address was already there.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { countFeedbackSince, insertFeedback, joinWaitlist, type Db } from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

/** Process-wide cap on waitlist sign-ups (SEC-M4): on top of the per-IP limit, bounds a distributed flood. */
export const WAITLIST_GLOBAL_PER_HOUR = 300;
/** Feedback per workspace and day (SEC-L). */
export const FEEDBACK_PER_DAY = 20;

const WaitlistBody = z.object({
  email: z.string().trim().email().max(254),
  locale: z.enum(["es", "en"]).default("es"),
  /** Explicit consent to be contacted about the beta (link to the privacy policy next to the box). */
  consent: z.literal(true),
  /** Honeypot: hidden in the form, any value means a bot. */
  website: z.string().max(200).optional(),
});

/** Only the path: no query string or fragment (they can carry search terms or tokens). */
const PagePath = z
  .string()
  .max(500)
  .transform((p) => p.split(/[?#]/)[0] ?? "")
  .pipe(
    z
      .string()
      .regex(/^\/[\w\-./]*$/)
      .max(200),
  );

const FeedbackBody = z.object({
  kind: z.enum(["bug", "idea", "other"]),
  message: z.string().trim().min(1).max(2000),
  pagePath: PagePath.nullable().optional(),
});

export function betaRoutes(
  app: FastifyInstance,
  options: { db: Db; now: () => Date },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  let window = { hour: -1, count: 0 };

  r.post(
    "/v1/waitlist",
    {
      config: { public: true, rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["beta"], body: WaitlistBody, response: { 202: z.object({ ok: z.literal(true) }) } },
    },
    async (request, reply) => {
      const now = options.now();
      const hour = Math.floor(now.getTime() / 3_600_000);
      if (window.hour !== hour) window = { hour, count: 0 };
      if (window.count >= WAITLIST_GLOBAL_PER_HOUR)
        throw new ApiError("RATE_LIMITED", "The waitlist is busy, try again later.");
      window.count += 1;
      // A filled honeypot gets the same answer and stores nothing.
      if (!request.body.website)
        await joinWaitlist(options.db, { email: request.body.email, locale: request.body.locale, now });
      return reply.status(202).send({ ok: true });
    },
  );

  r.post(
    "/v1/feedback",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["beta"], body: FeedbackBody, response: { 201: z.object({ id: z.string() }) } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const created = await request.withWorkspace(async (tx) => {
        const recent = await countFeedbackSince(
          tx,
          session.workspaceId,
          new Date(now.getTime() - 86_400_000),
        );
        if (recent >= FEEDBACK_PER_DAY)
          throw new ApiError("RATE_LIMITED", "Feedback limit reached for today.");
        return insertFeedback(tx, session.workspaceId, {
          kind: request.body.kind,
          message: request.body.message,
          pagePath: request.body.pagePath ?? null,
          now,
        });
      });
      return reply.status(201).send(created);
    },
  );
  done();
}
