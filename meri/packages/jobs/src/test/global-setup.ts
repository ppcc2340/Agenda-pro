import { ensureDevRoles, runMigrations } from "@meri/db";

const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

export default async function setup(): Promise<void> {
  await runMigrations(ADMIN);
  await ensureDevRoles(ADMIN);
}
