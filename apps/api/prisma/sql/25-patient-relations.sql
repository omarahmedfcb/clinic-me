-- Phase 4, PR 7d — kinship between patients. `PHASE-4.md` Q30.
--
--
-- NOT THE SAME THING AS A HOUSEHOLD (D28)
--
-- `contacts` is a shared phone. This is a family. A son with his own number is not in his mother's
-- household by D28's definition and is still her son, and a live-in grandparent shares the phone
-- and may be no relation at all. Two facts, two tables.
--
--
-- BOTH DIRECTIONS ARE STORED, AND THAT IS DELIBERATE
--
-- Bidirectional could be one row read from either end, with the reciprocal derived on the way out.
-- It is two rows instead, written in one transaction, because the reciprocal of "son" is "father"
-- or "mother" depending on the *other* patient's sex — a fact that can change from NULL to a value
-- later, which would silently change what an existing link means. Storing the label decided at the
-- time it was entered keeps the record saying what somebody actually said.
--
-- The cost is that the pair can be edited to disagree. Nothing edits them: rows are inserted and
-- deleted as a pair by the service, and there is no update path.

CREATE TYPE "PatientKinship" AS ENUM ('HUSBAND', 'WIFE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'RELATIVE');

CREATE TABLE "patient_relations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "related_patient_id" UUID NOT NULL,
    -- Read as: the related patient is the <relation> of the patient.
    "relation" "PatientKinship" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "patient_relations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "patient_relations"
    ADD CONSTRAINT "patient_relations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_relations"
    ADD CONSTRAINT "patient_relations_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_relations"
    ADD CONSTRAINT "patient_relations_related_patient_id_fkey"
    FOREIGN KEY ("related_patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_relations"
    ADD CONSTRAINT "patient_relations_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nobody is their own relative. A self-link would render as a patient listed under their own family.
ALTER TABLE "patient_relations"
    ADD CONSTRAINT "patient_relations_not_self"
    CHECK ("patient_id" <> "related_patient_id");

-- One relation per ordered pair. Two rows saying a person is both son and father of the same
-- patient is not a family, it is a data-entry mistake, and the database is where it stops.
CREATE UNIQUE INDEX "patient_relations_pair_key"
    ON "patient_relations" ("patient_id", "related_patient_id");

CREATE INDEX "patient_relations_tenant_patient_idx"
    ON "patient_relations" ("tenant_id", "patient_id");

ALTER TABLE patient_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_relations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_relations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER patient_relations_audit
  AFTER INSERT OR UPDATE OR DELETE ON patient_relations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
