import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

/** Apply all pending migrations with the owner connection. Safe to re-run. */
export async function runMigrations(adminUrl: string, log: (msg: string) => void = () => {}): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: resolve(here, "..", "drizzle") });
    log("migrations applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Dev/CI helper: give the app role a login (scripts/sql/db-roles.sql). */
export async function ensureDevRoles(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(resolve(here, "..", "..", "..", "scripts", "sql", "db-roles.sql"), "utf8"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
    process.exit(2);
  }
  runMigrations(url, (m) => {
    console.warn(m);
  })
    .then(() => (process.env.NODE_ENV === "production" ? undefined : ensureDevRoles(url)))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
