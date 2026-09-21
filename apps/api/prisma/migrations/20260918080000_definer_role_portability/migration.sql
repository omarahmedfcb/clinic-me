-- SECURITY DEFINER helpers get their own non-superuser owner, with explicit policies instead of the
-- superuser bypass they relied on. Managed PostgreSQL has no superuser, so FORCE RLS applied to them.

-- ============================================================================
-- Why this exists
--
-- 46 tables carry FORCE ROW LEVEL SECURITY, and FORCE subjects the table's owner to its policies
-- too. Locally the owner is the migration superuser, and a superuser bypasses RLS unconditionally,
-- so every SECURITY DEFINER helper read and wrote what it was written to. A managed PostgreSQL
-- (RDS, Cloud SQL, Azure) gives no superuser at all: the same functions then run as an ordinary
-- role and meet the policies head-on. Measured on a database whose schema is owned by a
-- NOSUPERUSER NOBYPASSRLS role: 134 of 734 integration tests failed, 156 of them on
-- "new row violates row-level security policy for table audit_logs" -- the audit triggers unable to
-- write the row they exist to write. `read_orphaned_audit_logs()` returned 0 rows instead of 1,
-- succeeding and returning nothing, which reads as "no orphaned rows" rather than as a fault.
--
-- The fix is not to hand anything BYPASSRLS -- managed providers do not grant it, which is the whole
-- point. Each helper is owned by `clinic_os_definer`, which holds exactly the policies its bodies
-- need and nothing else. That is narrower than what it replaces: a superuser bypassed every policy
-- on every table, while this role may read six tables and may insert audit rows.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_os_definer') THEN
    CREATE ROLE clinic_os_definer
      NOLOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$$;

-- Reassigning ownership requires membership of the target role. The migration role keeps it after
-- this migration, which costs nothing: clinic_os_definer cannot log in.
DO $$
BEGIN
  EXECUTE format('GRANT clinic_os_definer TO %I', current_user);
END
$$;

-- CREATE as well as USAGE: PostgreSQL refuses ALTER FUNCTION ... OWNER TO a role that cannot create
-- in the function's schema (42501, permission denied for schema public). The role cannot log in, so
-- nothing ever runs as it except the helpers below.
GRANT USAGE, CREATE ON SCHEMA public TO clinic_os_definer;

-- Privileges first; RLS is applied on top of them, never instead of them.
GRANT SELECT ON users, memberships, tenants, patients, appointments, doctors TO clinic_os_definer;
GRANT SELECT, INSERT ON audit_logs TO clinic_os_definer;

-- The reads the membership lookups and the platform aggregates make, and nothing wider. `users`
-- carries no RLS, so it needs no policy.
CREATE POLICY definer_reads ON memberships FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON tenants FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON patients FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON appointments FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON doctors FOR SELECT TO clinic_os_definer USING (true);

-- The audit triggers write rows for every tenant and for the platform (tenant_id IS NULL), so the
-- insert cannot be narrowed by tenant. The read is the break-glass path and IS narrowed: orphaned
-- rows only, which is tighter than the superuser bypass it replaces -- a superuser could read every
-- tenant's audit history through that function's body, and this role cannot.
CREATE POLICY definer_writes_audit ON audit_logs FOR INSERT TO clinic_os_definer WITH CHECK (true);
CREATE POLICY definer_reads_orphaned_audit ON audit_logs FOR SELECT TO clinic_os_definer
  USING (tenant_id IS NULL);

-- Ownership is moved for every SECURITY DEFINER function in the schema, derived from the catalogue
-- rather than from a list typed here: a helper added later and forgotten is exactly the case a
-- hand-written list misses. Extension-owned functions are excluded.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO clinic_os_definer', target.signature);
  END LOOP;
END
$$;
