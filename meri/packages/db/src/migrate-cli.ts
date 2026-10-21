/*
 * `pnpm db:migrate` entry point. Kept out of `migrate.ts`: once the library is bundled into an app (tsup), its
 * `import.meta.url` is the app's entry file, so an "am I the main module" check there would fire inside the API.
 */
import { ensureDevRoles, runMigrations } from "./migrate";

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  process.exit(2);
}
// Dev role password only for local databases or with an explicit opt-in (never by accident on staging).
const devRoles = process.env.MERI_DEV_ROLES === "1" || /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
runMigrations(url, (m) => {
  console.warn(m);
})
  .then(() => (devRoles && process.env.NODE_ENV !== "production" ? ensureDevRoles(url) : undefined))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
