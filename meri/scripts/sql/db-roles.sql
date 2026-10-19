-- Development / CI only. Gives the application role a login. Run as a superuser or the DB owner:
--   psql "$DATABASE_ADMIN_URL" -f scripts/sql/db-roles.sql
-- In production the password lives in the secrets manager, never here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_app') THEN
    CREATE ROLE meri_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE meri_app LOGIN PASSWORD 'meri_app';
