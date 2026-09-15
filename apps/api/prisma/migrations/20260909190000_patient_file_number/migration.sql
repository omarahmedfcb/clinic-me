-- Phase 5, PR 2 — the patient file number. `PHASE-5-PLAN.md` PR 2, carried from `PHASE-4.md` §4d.
--
-- ## Why a counter column and not a SEQUENCE
--
-- The number is **per clinic**, and a Postgres sequence is per database. One sequence would number
-- every clinic's patients from one shared counter, so the first patient of the second clinic would
-- be number 4,001 — which is not what a receptionist reads down a phone, and leaks how many
-- patients other clinics have.
--
-- A counter column on `tenants`, incremented under a row lock inside the transaction that creates
-- the patient, gives each clinic its own run of numbers. The lock is what makes it correct under
-- concurrency; `max(file_number) + 1` is the version that passes every single-threaded test and
-- hands two patients the same number the first time two receptionists register at once.
--
-- ## Existing rows are numbered, not left null
--
-- Backfilled in `created_at` order, so the oldest patient in each clinic is number 1. A nullable
-- column would put "no file number" on a printed sheet for every patient registered before today,
-- which is the state this exists to remove.

-- The backfill below is an UPDATE on two audited tables, and D16's trigger refuses a write with no
-- actor bound — correctly, since "who changed this row" must never be unanswerable. A migration is
-- the unattended case the rule names, so it binds the system actor.
--
-- Session-scoped (`false`), not transaction-local: `prisma migrate deploy` sends each statement
-- separately, so a transaction-local binding is already gone by the time the UPDATE runs — which
-- this migration demonstrated twice before the scope was changed. Reset at the end of the file.
SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "tenants" ADD COLUMN "next_patient_file_number" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "patients" ADD COLUMN "file_number" INTEGER;

-- Per clinic, oldest first. `row_number()` over a partition is the whole backfill.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n
  FROM patients
)
UPDATE patients SET file_number = numbered.n
FROM numbered WHERE patients.id = numbered.id;

-- The counter starts after whatever the backfill used, per clinic.
UPDATE tenants SET next_patient_file_number = COALESCE(
  (SELECT MAX(file_number) + 1 FROM patients WHERE patients.tenant_id = tenants.id),
  1
);

ALTER TABLE "patients" ALTER COLUMN "file_number" SET NOT NULL;

-- One number per clinic. This is the constraint that makes a duplicate impossible rather than
-- unlikely: the allocation below is careful, and careful is not the same as enforced.
CREATE UNIQUE INDEX "patients_tenant_id_file_number_key"
    ON "patients" ("tenant_id", "file_number");

ALTER TABLE "patients"
    ADD CONSTRAINT "patients_file_number_positive" CHECK ("file_number" > 0);

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_next_patient_file_number_positive"
    CHECK ("next_patient_file_number" > 0);


-- ## Allocation is a trigger, not application code
--
-- The number is taken here rather than in `patients.service.ts` for the reason `CLAUDE.md` gives
-- about invariants: eighteen places in this repository insert a patient — the service, the seed,
-- and sixteen integration fixtures — and an allocation living in one of them is an allocation the
-- other seventeen skip. A BEFORE INSERT trigger is the layer none of them can bypass.
--
-- `UPDATE … RETURNING` takes an exclusive lock on the tenant row, so two intakes racing in two
-- transactions are serialised: the second waits for the first to commit and then reads a counter
-- that has already moved. `max(file_number) + 1` is the version that passes every single-threaded
-- test and hands both receptionists the same number the first time two people register at once.
CREATE OR REPLACE FUNCTION allocate_patient_file_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.file_number IS NULL THEN
    UPDATE tenants
       SET next_patient_file_number = next_patient_file_number + 1
     WHERE id = NEW.tenant_id
    RETURNING next_patient_file_number - 1 INTO NEW.file_number;
  END IF;

  IF NEW.file_number IS NULL THEN
    RAISE EXCEPTION 'No tenant row to allocate a patient file number from: %', NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patients_allocate_file_number
  BEFORE INSERT ON patients
  FOR EACH ROW EXECUTE FUNCTION allocate_patient_file_number();

-- The binding does not outlive the migration.
SELECT set_config('app.current_actor_id', '', false);
