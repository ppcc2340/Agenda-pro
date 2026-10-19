/** Test connection strings. Defaults match docker-compose / scripts/sql/db-roles.sql; CI overrides them. */
export const TEST_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
export const TEST_APP_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
