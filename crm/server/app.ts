import { ensureServiceUser } from "./services/workflows.js";
import { columnRoutes, cellRoutes } from "./routes/columns.js";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { HttpError } from "./lib/errors.js";
import { requireAuth } from "./auth.js";
import { buildOpenApi, DOCS_HTML, DOCS_CSS, DOCS_JS } from "./openapi.js";
import { liveRoutes } from "./live.js";
import { requestLog, securityHeaders, optimisticConcurrency } from "./http.js";
import { authRoutes } from "./routes/auth.js";
import { contactRoutes } from "./routes/contacts.js";
import { companyRoutes } from "./routes/companies.js";
import { dealRoutes, pipelineRoutes } from "./routes/deals.js";
import { taskRoutes } from "./routes/tasks.js";
import { activityRoutes } from "./routes/activities.js";
import { ticketRoutes } from "./routes/tickets.js";
import { productRoutes, quoteRoutes } from "./routes/products.js";
import { adminRoutes } from "./routes/admin.js";
import { miscRoutes } from "./routes/misc.js";
import { workflowRoutes } from "./routes/workflows.js";
import { formAdminRoutes, formPublicRoutes } from "./routes/forms.js";
import { publicRoutes } from "./routes/public.js";
import { reportRoutes } from "./routes/reports.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { clmRoutes } from "./routes/clm.js";
import { signRoutes } from "./routes/sign.js";
import { registerWorkflowEngine } from "./services/workflows.js";
import { registerWebhookDispatcher } from "./services/webhooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let registered = false;

export function createApp(db: Db) {
  for (const w of db.all<{ id: string }>("SELECT id FROM workspaces")) ensureServiceUser(db, w.id);
  if (!registered) { registerWorkflowEngine(); registerWebhookDispatcher(); registered = true; }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(requestLog());
  app.use(securityHeaders());

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use("/api/auth", authRoutes(db));
  app.use(publicRoutes(db));
  app.use("/f", formPublicRoutes(db));
  app.use(signRoutes(db));

  const api = express.Router();
  api.use(requireAuth(db));
  api.use(optimisticConcurrency(db));
  const mounts: [string, ReturnType<typeof express.Router>][] = [
    ["/contacts", contactRoutes()],
    ["/companies", companyRoutes()],
    ["/deals", dealRoutes()],
    ["/pipelines", pipelineRoutes()],
    ["/tasks", taskRoutes()],
    ["/activities", activityRoutes()],
    ["/tickets", ticketRoutes()],
    ["/products", productRoutes()],
    ["/quotes", quoteRoutes()],
    ["/admin", adminRoutes()],
    ["/workflows", workflowRoutes()],
    ["/forms", formAdminRoutes()],
    ["/reports", reportRoutes()],
    ["/analytics", analyticsRoutes()],
    ["/clm", clmRoutes()],
    ["/columns", columnRoutes()],
    ["/cells", cellRoutes()],
    ["", miscRoutes()],
    ["", liveRoutes()],
  ];
  for (const [p, r] of mounts) { if (p) api.use(p, r); else api.use(r); }
  // especificación OpenAPI y lector (públicos: no exponen datos)
  const spec = buildOpenApi(mounts, process.env.npm_package_version ?? "1.0.0");
  app.get(["/api/openapi.json", "/api/v1/openapi.json"], (_req, res) => res.json(spec));
  app.get("/api/docs", (_req, res) => res.type("html").send(DOCS_HTML));
  app.get("/api/docs.css", (_req, res) => res.type("css").send(DOCS_CSS));
  app.get("/api/docs.js", (_req, res) => res.type("js").send(DOCS_JS));
  app.use("/api", api);
  app.use("/api/v1", api); // versioned alias for integrations with API key

  // Static frontend (production build)
  const candidates = [path.resolve(here, "../web"), path.resolve(here, "../dist/web")];
  const webDir = candidates.find((d) => fs.existsSync(path.join(d, "assets")) && fs.existsSync(path.join(d, "index.html")));
  if (webDir) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api|\/f\/|\/t\/|\/q\/|\/s\/|\/csat\/|\/hooks\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use((req, res) => { res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }); });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details ?? null });
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed") return res.status(400).json({ error: "JSON no válido" });
    console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", request_id: (req as Request & { rid?: string }).rid, path: req.path, error: (err as Error)?.message, stack: (err as Error)?.stack?.split("\n").slice(0, 6) }));
    res.status(500).json({ error: "Error interno del servidor", request_id: (req as Request & { rid?: string }).rid });
  });
  return app;
}
