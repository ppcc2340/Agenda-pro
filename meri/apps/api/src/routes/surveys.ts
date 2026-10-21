/**
 * In-app surveys (D-101): `GET /v1/surveys/next` says whether the Sean Ellis question is due; `POST
 * /v1/surveys/sean_ellis` records the answer or a dismissal. The rule lives in @meri/core (`seanEllisEligibility`).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { seanEllisEligibility } from "@meri/core";
import { getPreferences, listSurveyHistory, recordSurvey } from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const SurveyBody = z.union([
  z.object({
    answer: z.enum(["very", "somewhat", "not", "na"]),
    comment: z.string().trim().max(500).optional(),
  }),
  z.object({ dismiss: z.literal(true) }),
]);

export function surveyRoutes(app: FastifyInstance, options: { now: () => Date }, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/surveys/next",
    {
      preHandler: requireSession,
      schema: { tags: ["beta"], response: { 200: z.object({ survey: z.literal("sean_ellis").nullable() }) } },
    },
    async (request) => {
      const session = sessionOf(request);
      return request.withWorkspace(async (tx) => {
        const prefs = await getPreferences(tx, session.workspaceId);
        const history = await listSurveyHistory(tx, session.workspaceId);
        const due = seanEllisEligibility({
          onboardedAt: prefs?.onboardedAt ?? null,
          now: options.now(),
          history,
        });
        return { survey: due.eligible ? ("sean_ellis" as const) : null };
      });
    },
  );

  r.post(
    "/v1/surveys/sean_ellis",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["beta"], body: SurveyBody, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      await request.withWorkspace(async (tx) => {
        const prefs = await getPreferences(tx, session.workspaceId);
        const history = await listSurveyHistory(tx, session.workspaceId);
        // Only when it is due: one answer per account, no repeated dismissals from a stale tab.
        const due = seanEllisEligibility({ onboardedAt: prefs?.onboardedAt ?? null, now, history });
        if (!due.eligible) throw new ApiError("CONFLICT", `The survey is not due (${due.reason}).`);
        const body = request.body;
        await recordSurvey(
          tx,
          session.workspaceId,
          "dismiss" in body
            ? { dismissed: true, now }
            : { answer: body.answer, comment: body.comment ? body.comment : null, now },
        );
      });
      return reply.status(204).send(null);
    },
  );
  done();
}
