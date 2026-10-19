import { ensureDevRoles, runMigrations } from "../migrate";
import { TEST_ADMIN_URL } from "./urls";

/** Vitest global setup: migrate the test database with the owner role before any test runs. */
export default async function setup(): Promise<void> {
  await runMigrations(TEST_ADMIN_URL);
  await ensureDevRoles(TEST_ADMIN_URL);
}
