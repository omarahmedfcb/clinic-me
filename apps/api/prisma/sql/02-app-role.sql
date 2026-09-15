-- Phase 1, Checkpoint 2 (addendum) — hand-written SQL that cannot be expressed in schema.prisma.
-- Source of truth: chat record following SCHEMA-DECISIONS.md D4's RLS section.
--
-- Problem: docker-compose.yml's only Postgres role is created from POSTGRES_USER by the
-- official postgres:16 image, which makes it a SUPERUSER with BYPASSRLS. Postgres superusers
-- bypass Row-Level Security unconditionally -- FORCE ROW LEVEL SECURITY has no effect on them.
-- If the application ever connects as that role, every RLS policy in 01-constraints.sql is a
-- no-op: the isolation tests would pass locally while the production database enforces nothing.
--
-- Fix: a second, ordinary role for the application to connect as. The superuser role
-- (POSTGRES_USER, e.g. "clinic_os") remains for migrations only -- CREATE EXTENSION,
-- ENABLE/FORCE ROW LEVEL SECURITY, and CREATE POLICY all require elevated privileges that this
-- new role deliberately does not have.
--
-- No password is set here. Migration files are checked into git; a hardcoded password would be
-- a secret in source control. The password is set out-of-band via ALTER ROLE, once per
-- environment, from the password embedded in APP_DATABASE_URL / TEST_APP_DATABASE_URL, which
-- live only in the uncommitted apps/api/.env (see .env.example, and docs/SETUP.md section 6 --
-- the role is cluster-wide, so both of those must carry the SAME password). Application runtime
-- code must connect using APP_DATABASE_URL, not DATABASE_URL
-- -- DATABASE_URL stays pointed at the superuser role for Prisma CLI operations only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_os_app') THEN
    CREATE ROLE clinic_os_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO clinic_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clinic_os_app;

-- Future tables created by the superuser role (via further Prisma migrations) grant the same
-- privileges to clinic_os_app automatically -- otherwise every new table needs a follow-up GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE clinic_os IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clinic_os_app;
