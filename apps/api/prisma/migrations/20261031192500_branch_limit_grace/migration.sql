-- Branches step 6.3 (BRANCHES-DESIGN §9 A, ruled 2026-10-30 and 2026-10-31): a limit lowered below the active count
-- opens a 30-day grace period; the admin chooses which branches go; after it, a pass suspends them, never over a booking.

CREATE TYPE "BranchGraceStatus" AS ENUM ('OPEN', 'DEFERRED', 'DONE', 'CLEARED');

-- OPEN: within the grace period. DEFERRED: it ended with a future booking in a branch due to go, so that branch waits
-- and the operator sees it. DONE: every excess branch suspended. CLEARED: the excess went away (limit raised, or fewer branches).
CREATE TABLE "branch_limit_graces" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "limit_change_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "BranchGraceStatus" NOT NULL DEFAULT 'OPEN',
    "deferred_at" TIMESTAMPTZ(6),
    "deferred_reason" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "branch_limit_graces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_limit_graces_ends_after_start" CHECK ("ends_at" > "started_at"),
    CONSTRAINT "branch_limit_graces_resolved_iff_final" CHECK (("status" IN ('DONE', 'CLEARED')) = ("resolved_at" IS NOT NULL)),
    CONSTRAINT "branch_limit_graces_deferral_explained" CHECK ("status" <> 'DEFERRED' OR ("deferred_at" IS NOT NULL AND btrim("deferred_reason") <> ''))
);
CREATE UNIQUE INDEX "branch_limit_graces_one_unresolved_per_tenant" ON "branch_limit_graces"("tenant_id") WHERE "status" IN ('OPEN', 'DEFERRED');
ALTER TABLE "branch_limit_graces" ADD CONSTRAINT "branch_limit_graces_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_limit_graces" ADD CONSTRAINT "branch_limit_graces_limit_change_id_fkey"
    FOREIGN KEY ("limit_change_id") REFERENCES "branch_limit_changes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The admin's choice of which branches go. Replaceable while the grace is unresolved, hence DELETE.
CREATE TABLE "branch_grace_choices" (
    "id" UUID NOT NULL,
    "grace_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "chosen_by" UUID NOT NULL,
    "chosen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_grace_choices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "branch_grace_choices_grace_id_branch_id_key" ON "branch_grace_choices"("grace_id", "branch_id");
ALTER TABLE "branch_grace_choices" ADD CONSTRAINT "branch_grace_choices_grace_id_fkey"
    FOREIGN KEY ("grace_id") REFERENCES "branch_limit_graces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_grace_choices" ADD CONSTRAINT "branch_grace_choices_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_grace_choices" ADD CONSTRAINT "branch_grace_choices_chosen_by_fkey"
    FOREIGN KEY ("chosen_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE branch_limit_graces ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_limit_graces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_limit_graces
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branch_limit_graces TO clinic_os_app;
CREATE TRIGGER branch_limit_graces_audit AFTER INSERT OR UPDATE OR DELETE ON branch_limit_graces
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE branch_grace_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_grace_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_grace_choices
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON branch_grace_choices TO clinic_os_app;
CREATE TRIGGER branch_grace_choices_audit AFTER INSERT OR UPDATE OR DELETE ON branch_grace_choices
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Two cross-clinic reads, each the platform_clinic_counts() shape and owned by the definer role, which may read
-- exactly what they read: the unattended pass's due list, and the operator's view of unresolved graces.
GRANT SELECT ON branch_limit_graces TO clinic_os_definer;
CREATE POLICY definer_reads ON branch_limit_graces FOR SELECT TO clinic_os_definer USING (true);

CREATE FUNCTION due_branch_limit_graces(p_now timestamptz)
RETURNS TABLE (grace_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT g.id, g.tenant_id FROM branch_limit_graces g
   WHERE g.status IN ('OPEN', 'DEFERRED') AND g.ends_at <= p_now
   ORDER BY g.ends_at;
$$;
REVOKE ALL ON FUNCTION due_branch_limit_graces(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_branch_limit_graces(timestamptz) TO clinic_os_app;
ALTER FUNCTION due_branch_limit_graces(timestamptz) OWNER TO clinic_os_definer;

CREATE FUNCTION platform_branch_limit_graces()
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  clinic_name text,
  status "BranchGraceStatus",
  current_limit integer,
  active_branches integer,
  started_at timestamptz,
  ends_at timestamptz,
  deferred_at timestamptz,
  deferred_reason text
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
    RAISE EXCEPTION 'platform_branch_limit_graces() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.', ERRCODE = 'raise_exception';
  END IF;
  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin FROM users u WHERE u.id = v_actor_id;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_branch_limit_graces() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT g.id, g.tenant_id, t.name, g.status, t.max_branches,
         (SELECT count(*)::int FROM branches b WHERE b.tenant_id = g.tenant_id AND b.status = 'ACTIVE'),
         g.started_at, g.ends_at, g.deferred_at, g.deferred_reason
    FROM branch_limit_graces g
    JOIN tenants t ON t.id = g.tenant_id
   WHERE g.status IN ('OPEN', 'DEFERRED')
   ORDER BY (g.status = 'DEFERRED') DESC, g.ends_at;
END;
$$;
REVOKE ALL ON FUNCTION platform_branch_limit_graces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_branch_limit_graces() TO clinic_os_app;
ALTER FUNCTION platform_branch_limit_graces() OWNER TO clinic_os_definer;
