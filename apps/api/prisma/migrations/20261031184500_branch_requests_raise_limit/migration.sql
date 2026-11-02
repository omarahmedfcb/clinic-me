-- Branches step 6.2 (BRANCHES-DESIGN §1.4, §9 A; Q10): `branch_requests` becomes the clinic's request to raise its
-- branch limit. Nothing ever wrote the old shape (a proposed branch), so the migration refuses rather than convert.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = 'tenants' AND n_live_tup > 0) THEN
    RAISE EXCEPTION 'branch requests migration: % cannot see clinics through RLS, so the emptiness check would see nothing. Run it as the migration superuser.', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM branch_requests) THEN
    RAISE EXCEPTION 'branch requests migration: branch_requests holds rows of the old CREATE shape, which nothing was meant to write. Decide what they mean before converting them.';
  END IF;
END $$;

ALTER TABLE "branch_requests" DROP CONSTRAINT "branch_requests_approval_names_branch";
ALTER TABLE "branch_requests" DROP CONSTRAINT "branch_requests_tenant_id_created_branch_id_fkey";
ALTER TABLE "branch_requests" DROP COLUMN "created_branch_id", DROP COLUMN "kind", DROP COLUMN "payload";
DROP TYPE "BranchRequestKind";

ALTER TABLE "branch_requests"
  ADD COLUMN "requested_limit" INTEGER NOT NULL,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "limit_change_id" UUID,
  ADD CONSTRAINT "branch_requests_requested_limit_at_least_two" CHECK ("requested_limit" >= 2),
  -- An approval names the limit change it made, and only an approval does.
  ADD CONSTRAINT "branch_requests_approval_names_limit_change" CHECK (("status" = 'APPROVED') = ("limit_change_id" IS NOT NULL));
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_limit_change_id_fkey"
    FOREIGN KEY ("limit_change_id") REFERENCES "branch_limit_changes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "branch_requests_one_pending_per_tenant" ON "branch_requests"("tenant_id") WHERE "status" = 'PENDING';

-- The definer role reads exactly what the queue function reads (20260918080000_definer_role_portability's pattern).
GRANT SELECT ON branch_requests, branches TO clinic_os_definer;
CREATE POLICY definer_reads ON branch_requests FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON branches FOR SELECT TO clinic_os_definer USING (true);

-- The operator's queue reads across clinics, which every RLS policy forbids; the platform_clinic_counts() shape:
-- SECURITY DEFINER, refusing any actor who is not an ACTIVE platform admin, a return type that cannot widen silently.
CREATE FUNCTION platform_branch_requests()
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  clinic_name text,
  status "BranchRequestStatus",
  requested_limit integer,
  current_limit integer,
  active_branches integer,
  note text,
  requested_by_name text,
  created_at timestamptz,
  decided_at timestamptz,
  decision_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_is_admin boolean;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'platform_branch_requests() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.', ERRCODE = 'raise_exception';
  END IF;
  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin FROM users u WHERE u.id = v_actor_id;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_branch_requests() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT r.id, r.tenant_id, t.name, r.status, r.requested_limit, t.max_branches,
         (SELECT count(*)::int FROM branches b WHERE b.tenant_id = r.tenant_id AND b.status = 'ACTIVE'),
         r.note, u.full_name, r.created_at, r.decided_at, r.decision_reason
    FROM branch_requests r
    JOIN tenants t ON t.id = r.tenant_id
    JOIN users u ON u.id = r.requested_by
   ORDER BY (r.status = 'PENDING') DESC, r.created_at;
END;
$$;

REVOKE ALL ON FUNCTION platform_branch_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_branch_requests() TO clinic_os_app;
-- Owned by the definer role, not the migration role: on a managed instance the latter cannot bypass RLS.
ALTER FUNCTION platform_branch_requests() OWNER TO clinic_os_definer;
