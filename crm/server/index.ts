import fs from "node:fs";
import path from "node:path";
import { Db } from "./db.js";
import { createApp } from "./app.js";
import { bootstrap } from "./seed.js";
import { startScheduler } from "./services/scheduler.js";

loadEnv();
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DATABASE_PATH ?? "./data/crm.db";
const db = new Db(dbPath);
const info = bootstrap(db, { demo: process.env.SEED_DEMO !== "0" });
const app = createApp(db);
startScheduler(db);
app.listen(port, () => {
  console.log(`CRM listo en http://localhost:${port}`);
  if (info.createdAdmin) console.log(`Usuario inicial: ${info.adminEmail} / ${info.adminPassword}`);
  if (info.seededDemo) console.log("Datos de demostración cargados (SEED_DEMO=0 para desactivar).");
  console.log(`Email: modo ${process.env.EMAIL_MODE === "smtp" ? "SMTP" : "fake (los envíos se registran, no salen)"}`);
});

function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
}
