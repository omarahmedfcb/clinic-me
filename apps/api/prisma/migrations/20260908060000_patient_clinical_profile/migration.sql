-- Phase 4, PR 7b — the patient-level clinical profile. `PHASE-4-PLAN.md` PR 7b.
--
--
-- ITS OWN TABLE, AND NOT COLUMNS ON `patients`
--
-- Family history and risk factors are clinical content. `patients` is read by reception on every
-- screen they have -- the book, search, the detail page -- so a column there would be one forgotten
-- `select` away from a receptionist reading a family cancer history.
--
-- CLAUDE.md requires the boundary to be "enforced by separate endpoints and separate DTOs, never by
-- filtering fields out of one response". A separate table is what makes that possible: the reception
-- read paths cannot accidentally include a column from a table they never join.
--
--
-- ONE ROW PER PATIENT
--
-- Not a history of profiles. Family history is a standing fact about a person that gets corrected,
-- not a series of dated observations -- those are visits. The audit trigger below keeps the trail of
-- what changed and who changed it, which is what a correction needs.
--
--
-- ALLERGIES ARE NOT HERE
--
-- `patient_allergies` already exists and the safety summary reads it. A second allergy list would
-- be a second thing to keep in step, and one of the two would go stale -- which for allergies is the
-- most dangerous stale field in the system.

CREATE TABLE "patient_clinical_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "family_history" TEXT,
    "risk_factors" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "patient_clinical_profiles_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "patient_clinical_profiles"
    ADD CONSTRAINT "patient_clinical_profiles_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_clinical_profiles"
    ADD CONSTRAINT "patient_clinical_profiles_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_clinical_profiles"
    ADD CONSTRAINT "patient_clinical_profiles_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One profile per patient, at the database. Two rows would let two doctors each hold a half-written
-- family history and neither would know the other existed.
CREATE UNIQUE INDEX "patient_clinical_profiles_patient_id_key"
    ON "patient_clinical_profiles" ("patient_id");

CREATE INDEX "patient_clinical_profiles_tenant_id_idx"
    ON "patient_clinical_profiles" ("tenant_id");

-- Tenant isolation, identical in shape to every other tenant-scoped table.
-- NULLIF(...) means an unbound session variable fails closed: zero rows visible, zero writable.
ALTER TABLE patient_clinical_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_clinical_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_clinical_profiles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Not optional and not automatic: the audit trigger list is a literal array, which is how
-- `attachments` once ended up with a gap. A corrected family history must leave a trace.
CREATE TRIGGER patient_clinical_profiles_audit
  AFTER INSERT OR UPDATE OR DELETE ON patient_clinical_profiles
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
