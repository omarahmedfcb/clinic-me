-- Phase 4, PR 7e — the append-only clinical profile (Q22) and what a visit orders (Q24).
--
-- Every existing `patient_clinical_profiles` row becomes the first entry for its field, authored by
-- its `updated_by_user_id` at its `updated_at`. Nothing is dropped before it is copied.

CREATE TYPE "ClinicalProfileField" AS ENUM (
  'PAST_MEDICAL',
  'PAST_SURGICAL',
  'CHRONIC_CONDITIONS',
  'CHRONIC_MEDICATIONS',
  'FAMILY_HISTORY',
  'RISK_FACTORS'
);

CREATE TABLE "patient_clinical_profile_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "field" "ClinicalProfileField" NOT NULL,
    "content" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "patient_clinical_profile_entries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "patient_clinical_profile_entries"
    ADD CONSTRAINT "pcpe_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_clinical_profile_entries"
    ADD CONSTRAINT "pcpe_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_clinical_profile_entries"
    ADD CONSTRAINT "pcpe_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An empty entry is not an observation. Whitespace-only is the same thing typed by accident.
ALTER TABLE "patient_clinical_profile_entries"
    ADD CONSTRAINT "pcpe_content_not_blank" CHECK (btrim("content") <> '');

CREATE INDEX "pcpe_tenant_id_patient_id_created_at_idx"
    ON "patient_clinical_profile_entries" ("tenant_id", "patient_id", "created_at");

ALTER TABLE patient_clinical_profile_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_clinical_profile_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_clinical_profile_entries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Append-only (D5). Q22's whole point: a clinical record that can be silently rewritten is not one.
CREATE TRIGGER patient_clinical_profile_entries_append_only
  BEFORE UPDATE OR DELETE ON patient_clinical_profile_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER patient_clinical_profile_entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON patient_clinical_profile_entries
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The audit trigger refuses a write with no actor bound (D16), and a migration has none. Bound to
-- the system actor, which is the path that error's own hint names. Session-scoped rather than
-- transaction-scoped because the migration runner sends each statement separately, so a
-- transaction-local setting would be gone by the INSERT below. Cleared again after the copy.
SELECT set_config('app.current_actor_id', system_actor_id()::text, false),
       set_config('app.current_ip', 'migration', false),
       set_config('app.current_user_agent', '20260908140000_clinical_profile_entries_and_orders', false);

-- Every row PR 7b wrote, carried across with its own author and its own timestamp. A profile that
-- lost its history in the migration that made it append-only would be the joke version of Q22.
INSERT INTO "patient_clinical_profile_entries"
  ("id", "tenant_id", "patient_id", "field", "content", "author_user_id", "created_at")
SELECT uuid_generate_v7(), p.tenant_id, p.patient_id, 'FAMILY_HISTORY', p.family_history,
       p.updated_by_user_id, p.updated_at
  FROM "patient_clinical_profiles" p
 WHERE btrim(COALESCE(p.family_history, '')) <> '';

INSERT INTO "patient_clinical_profile_entries"
  ("id", "tenant_id", "patient_id", "field", "content", "author_user_id", "created_at")
SELECT uuid_generate_v7(), p.tenant_id, p.patient_id, 'RISK_FACTORS', p.risk_factors,
       p.updated_by_user_id, p.updated_at
  FROM "patient_clinical_profiles" p
 WHERE btrim(COALESCE(p.risk_factors, '')) <> '';

SELECT set_config('app.current_actor_id', '', false);

DROP TABLE "patient_clinical_profiles";

-- Q24. Free text beside the structured lines, because a request is often a sentence.
ALTER TABLE "visits" ADD COLUMN "investigations" TEXT;

CREATE TABLE "visit_investigations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "visit_investigations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "visit_investigations"
    ADD CONSTRAINT "visit_investigations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "visit_investigations"
    ADD CONSTRAINT "visit_investigations_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "visit_investigations"
    ADD CONSTRAINT "visit_investigations_name_not_blank" CHECK (btrim("name") <> '');

CREATE INDEX "visit_investigations_tenant_id_visit_id_idx"
    ON "visit_investigations" ("tenant_id", "visit_id");

ALTER TABLE visit_investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_investigations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_investigations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER visit_investigations_audit
  AFTER INSERT OR UPDATE OR DELETE ON visit_investigations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
