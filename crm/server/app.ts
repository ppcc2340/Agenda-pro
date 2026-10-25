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
  app.use((_req, res, next) => { res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "same-origin"); next(); });

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use("/api/auth", authRoutes(db));
  app.use(publicRoutes(db));
  app.use("/f", formPublicRoutes(db));
  app.use(signRoutes(db));

  const api = express.Router();
  api.use(requireAuth(db));
  api.use("/contacts", contactRoutes());
  api.use("/companies", companyRoutes());
  api.use("/deals", dealRoutes());
  api.use("/pipelines", pipelineRoutes());
  api.use("/tasks", taskRoutes());
  api.use("/activities", activityRoutes());
  api.use("/tickets", ticketRoutes());
  api.use("/products", productRoutes());
  api.use("/quotes", quoteRoutes());
  api.use("/admin", adminRoutes());
  api.use("/workflows", workflowRoutes());
  api.use("/forms", formAdminRoutes());
  api.use("/reports", reportRoutes());
  api.use("/clm", clmRoutes());
  api.use("/columns", columnRoutes());
  api.use("/cells", cellRoutes());
  api.use(miscRoutes());
  app.use("/api", api);
  app.use("/api/v1", api); // versioned alias for integrations with API key

  // Static frontend (production build)
  const candidates = [path.resolve(here, "../web"), path.resolve(here, "../dist/web")];
  const webDir = candidates.find((d) => fs.existsSync(path.join(d, "assets")) && fs.existsSync(path.join(d, "index.html")));
  if (webDir) {
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api|\/f\/|\/t\/|\/q\/|\/s\/|\/hooks\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use((req, res) => { res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details ?? null });
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed") return res.status(400).json({ error: "JSON no válido" });
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  });
  return app;
}
