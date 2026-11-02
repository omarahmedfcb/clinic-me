-- Branches step 6.1 (BRANCHES-DESIGN §9 ruling A): the operator's per-clinic branch limit, every change to it kept
-- in its own append-only table, and the database refusing an ACTIVE branch past it.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = 'tenants' AND n_live_tup > 0) THEN
    RAISE EXCEPTION 'branch limit migration: % cannot see clinics through RLS, so the backfill would touch nothing. Run it as the migration superuser.', current_user;
  END IF;
END $$;

SELECT set_config('app.current_actor_id', system_actor_id()::text, false),
       set_config('app.current_user_agent', 'migration:20261031182000_branch_limit', false);

-- A clinic starts at the branches it already has, never fewer: nothing existing is pushed over its limit.
ALTER TABLE "tenants" ADD COLUMN "max_branches" INTEGER;
UPDATE "tenants" t
   SET "max_branches" = GREATEST(1, (SELECT count(*) FROM "branches" b WHERE b."tenant_id" = t."id" AND b."status" = 'ACTIVE'));
ALTER TABLE "tenants"
  ALTER COLUMN "max_branches" SET NOT NULL,
  ALTER COLUMN "max_branches" SET DEFAULT 1,
  ADD CONSTRAINT "tenants_max_branches_at_least_one" CHECK ("max_branches" >= 1);

CREATE TABLE "branch_limit_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "previous_limit" INTEGER NOT NULL,
    "new_limit" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_limit_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_limit_changes_is_a_change" CHECK ("previous_limit" <> "new_limit"),
    CONSTRAINT "branch_limit_changes_new_limit_at_least_one" CHECK ("new_limit" >= 1),
    CONSTRAINT "branch_limit_changes_reason_present" CHECK (btrim("reason") <> '')
);
CREATE INDEX "branch_limit_changes_tenant_id_changed_at_idx" ON "branch_limit_changes"("tenant_id", "changed_at");
ALTER TABLE "branch_limit_changes" ADD CONSTRAINT "branch_limit_changes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_limit_changes" ADD CONSTRAINT "branch_limit_changes_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE branch_limit_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_limit_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_limit_changes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON branch_limit_changes TO clinic_os_app;
CREATE TRIGGER branch_limit_changes_audit AFTER INSERT OR UPDATE OR DELETE ON branch_limit_changes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER branch_limit_changes_append_only BEFORE UPDATE OR DELETE ON branch_limit_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A branch becoming ACTIVE (created, or reactivated) is refused past the limit. The clinic row is locked
-- first, so two branches created at once cannot both see room for one. Lowering the limit refuses nothing.
CREATE FUNCTION enforce_branch_limit() RETURNS trigger AS $$
DECLARE
  v_limit integer;
  v_active integer;
BEGIN
  IF NEW.status <> 'ACTIVE' OR (TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  SELECT max_branches INTO v_limit FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
  SELECT count(*) INTO v_active FROM branches WHERE tenant_id = NEW.tenant_id AND status = 'ACTIVE' AND id <> NEW.id;
  IF v_active >= v_limit THEN
    RAISE EXCEPTION 'branch limit reached: the clinic has % active branches and is allowed %', v_active, v_limit
      USING ERRCODE = 'check_violation', CONSTRAINT = 'branches_within_max_branches';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER branches_within_max_branches BEFORE INSERT OR UPDATE OF status ON branches
  FOR EACH ROW EXECUTE FUNCTION enforce_branch_limit();

SELECT set_config('app.current_actor_id', '', false),
       set_config('app.current_user_agent', '', false);
