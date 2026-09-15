-- Phase 4 — the clinical safety summary. `PHASE-4.md`.
--
-- One table, and a derivation that is deliberately NOT a table.
--
--
-- WHY ALLERGIES ARE STORED AND CHRONIC MEDICATION IS DERIVED
--
-- The founder's ruling, and it is the more important half of this migration. A
-- `patient_medications` table would be a second copy of what the prescriptions already say, and it
-- would go stale the first time a doctor changes a dose in a prescription and does not mirror it
-- here. **A stale medication list in a safety summary is worse than an empty one, because it will
-- be trusted.** So current medication is read from prescription items at query time, carrying the
-- prescription it came from and its date, and the interface shows that provenance rather than
-- presenting it as a fact somebody entered.
--
-- Allergies have the opposite shape. Nothing else in the system records them, they are not derived
-- from any other clinical act, and they must be assertable independently of whether the patient has
-- ever been prescribed anything. So they are stored.
--
--
-- WHY AN EMPTY LIST IS NOT AN ANSWER
--
-- `allergies_reviewed_at` exists because an empty allergy list means two opposite things: "this
-- patient has no known allergies" and "nobody has ever asked". On a summary whose stated purpose is
-- preventing harm, a blank box that reads as reassurance it has not earned is the failure mode.
-- With the timestamp the interface can distinguish "No known allergies — reviewed 12 Mar" from
-- "Not yet recorded", and only the first is reassurance.
--
--
-- NEVER HARD-DELETED
--
-- `ENTERED_IN_ERROR` rather than DELETE, per CLAUDE.md: a retracted allergy is a clinical event
-- worth keeping. The audit trigger below covers every change either way.

CREATE TYPE "AllergySeverity" AS ENUM (
  'MILD',
  'MODERATE',
  'SEVERE',
  'LIFE_THREATENING'
);

CREATE TYPE "AllergyStatus" AS ENUM (
  'ACTIVE',
  'RESOLVED',
  -- Recorded in error. Kept rather than deleted, and excluded from the summary.
  'ENTERED_IN_ERROR'
);

CREATE TABLE patient_allergies (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  patient_id          UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,

  -- What the patient reacts to, as the doctor wrote it. Free text, and stored byte-identical:
  -- clinical content is never normalised (the patient-name normalisation is for retrieval only).
  substance           TEXT NOT NULL,
  -- Ready for a coded catalogue without a rewrite -- the same shape the prescription items will
  -- take when a licensed medication database exists. NULL until then, never invented.
  substance_code      TEXT,
  code_system         TEXT,

  reaction            TEXT,
  severity            "AllergySeverity" NOT NULL,
  status              "AllergyStatus" NOT NULL DEFAULT 'ACTIVE',
  notes               TEXT,

  -- Provenance. A clinical assertion that cannot say who made it or when is not much of an
  -- assertion; this is also what lets the summary show the age of what it is displaying.
  recorded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The summary reads every ACTIVE allergy for one patient, on every appointment a doctor opens.
CREATE INDEX patient_allergies_tenant_id_patient_id_idx
  ON patient_allergies (tenant_id, patient_id);

COMMENT ON TABLE patient_allergies IS
  'Known allergies, asserted rather than derived. Chronic medication is deliberately NOT stored '
  'here -- it is derived from prescriptions at query time so it cannot go stale. PHASE-4.md.';


-- "Has anybody asked?", which an empty list cannot answer. See the header.
ALTER TABLE patients ADD COLUMN allergies_reviewed_at TIMESTAMPTZ(6);
ALTER TABLE patients ADD COLUMN allergies_reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN patients.allergies_reviewed_at IS
  'When a clinician last confirmed the allergy list. NULL means never asked, which the summary '
  'must show differently from "no known allergies" -- an empty list alone is ambiguous.';


-- Tenant isolation, identical in shape to every other tenant-scoped table (01-constraints.sql).
-- NULLIF(...) means an unbound session variable fails closed: zero rows visible, zero writable.
ALTER TABLE patient_allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_allergies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_allergies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- The audit trigger is NOT optional and NOT automatic.
--
-- 07-audit-triggers.sql attaches these from a literal array of table names, so a new table gets no
-- audit trail unless it is named somewhere. That is precisely how `attachments` ended up with a
-- gap. An allergy record is exactly the kind of row whose deletion must leave a trace.
CREATE TRIGGER patient_allergies_audit
  AFTER INSERT OR UPDATE OR DELETE ON patient_allergies
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
