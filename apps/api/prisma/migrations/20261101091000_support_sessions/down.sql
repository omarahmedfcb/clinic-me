-- Reverses 20261101091000_support_sessions, access_grants included exactly as it stood, so down then up round-trips.
-- Refuses over sessions: each is a record of the vendor inside a clinic.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM support_sessions) THEN
    RAISE EXCEPTION 'support sessions down: sessions exist, and a session is a record, not scaffolding.';
  END IF;
END $$;

DROP FUNCTION platform_support_sessions();
DROP TRIGGER "tenants_support_switch_off_ends_sessions" ON "tenants";
DROP FUNCTION end_support_sessions_on_switch_off();
DROP TABLE "support_sessions";
DROP FUNCTION enforce_support_session();
DROP TYPE "SupportSessionStatus";

CREATE TABLE "access_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "granted_to_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "access_grants_tenant_id_idx" ON "access_grants"("tenant_id");
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_to_user_id_fkey" FOREIGN KEY ("granted_to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_grants
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON access_grants TO clinic_os_app;
CREATE TRIGGER access_grants_audit AFTER INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION audit_row_change();

DELETE FROM _prisma_migrations WHERE migration_name = '20261101091000_support_sessions';
