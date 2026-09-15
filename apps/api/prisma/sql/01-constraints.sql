-- Phase 1, Checkpoint 2 — hand-written SQL that cannot be expressed in schema.prisma.
-- Source of truth per SCHEMA-DECISIONS.md D4. See that document for the reasoning behind
-- each section; this file only implements it.
--
-- Application: this file is NOT applied by itself. Its content is copied verbatim into a
-- dedicated Prisma migration folder (prisma/migrations/<timestamp>_constraints/migration.sql)
-- so `prisma migrate deploy` on a fresh clone applies it automatically, in order, with no
-- manual step. See the chat record / PR description for the exact commands — they require a
-- live Postgres instance, which does not exist yet in this environment (no docker-compose.yml
-- has been created and no database has been provisioned).

-- ============================================================================
-- 1. Extension required for the exclusion constraint below.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================================
-- 2. Double-booking prevention (ARCHITECTURE.md §9, predicate per D3).
--    tenant_id is part of the constraint key: two different clinics may each have their own
--    doctor row with overlapping schedules, and the constraint must not treat those as a
--    conflict with each other.
-- ============================================================================

ALTER TABLE appointments
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    tenant_id WITH =,
    doctor_id WITH =,
    tstzrange(scheduled_start, scheduled_end) WITH &&
  )
  WHERE (status NOT IN ('CANCELLED', 'NO_SHOW') AND allow_overlap = false);

-- ============================================================================
-- 3. Row-Level Security on the 12 clinical/financial tables (D4, corrected list).
--
--    a) ENABLE + FORCE on every table. Without FORCE, the table owner — which is the role the
--       application connects as — bypasses RLS entirely, and every isolation test still
--       passes while the production database enforces nothing.
--    b) Every policy carries both USING (read visibility) and WITH CHECK (write legality).
--       USING alone would still let a session write a row stamped with another tenant's id.
--    c) NULLIF(current_setting('app.current_tenant_id', true), '')::uuid, never a bare cast.
--       A bare current_setting(...)::uuid throws on an empty string. NULLIF turns "unset" into
--       NULL, and NULL = anything is never true — an unset session variable fails closed
--       (zero rows visible, zero rows writable) instead of throwing or, worse, matching.
-- ============================================================================

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patients
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visits
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE visit_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_revisions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON prescriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE prescription_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON prescription_items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE payment_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_adjustments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE treatment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatment_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON treatment_plans
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE treatment_plan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatment_plan_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON treatment_plan_sessions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE prescription_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON prescription_access_tokens
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attachments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================================
-- 4. Append-only enforcement (D5). Trigger, not REVOKE, because the application connects as a
--    single role that also needs write access to these tables (INSERT must remain legal).
-- ============================================================================

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER appointment_events_append_only
  BEFORE UPDATE OR DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER visit_revisions_append_only
  BEFORE UPDATE OR DELETE ON visit_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER payment_adjustments_append_only
  BEFORE UPDATE OR DELETE ON payment_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ============================================================================
-- 5. remaining_minor as a real generated column (D7). Prisma created it as a plain nullable
--    INT because the schema DSL has no GENERATED ALWAYS AS syntax — replace it here.
-- ============================================================================

ALTER TABLE payments DROP COLUMN remaining_minor;

ALTER TABLE payments ADD COLUMN remaining_minor INT
  GENERATED ALWAYS AS (amount_due_minor - amount_paid_minor) STORED;
