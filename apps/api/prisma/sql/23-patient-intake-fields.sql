-- Phase 4, PR 7a — patient intake. `PHASE-4-PLAN.md` PR 7a, `SCHEMA-DECISIONS.md` D26/D27/D28.
--
-- Four columns and one partial unique index. No column is made NOT NULL.
--
--
-- WHY NOTHING BECOMES NOT NULL, WHEN D26 SAYS THESE ARE REQUIRED
--
-- D26 requires date of birth, gender and nationality **at intake**, reversing the 21 August ruling
-- that made the first two optional. It deliberately does not require them in the schema.
--
-- Making them NOT NULL means backfilling every patient already recorded without them, and the only
-- values available are guesses. That is exactly the falsification refused for
-- `appointments.quoted_price_minor`: a backfilled row asserts something about a person nobody
-- asked, and is indistinguishable from a row where somebody did. NULL means "not recorded", which
-- is the truth about those rows.
--
-- The gap between "required at intake" and "nullable in the column" is carried by a derived
-- incomplete flag -- computed on read, never stored, so it cannot go stale and no job maintains it.
--
--
-- NATIONALITY IS ISO 3166-1 alpha-2, DEFAULT NULL RATHER THAN 'EG'
--
-- 'EG' is the default the *form* offers, not a fact about rows written before this column existed.
-- Defaulting the column would silently assert that every existing patient is Egyptian, which is a
-- claim nobody made and which the incomplete badge would then fail to flag.
--
--
-- THE NATIONAL ID INDEX IS PARTIAL, AND IT IS THE ENFORCEMENT (D27)
--
-- Two receptionists registering the same walk-in seconds apart is precisely the race a service-layer
-- "does this ID exist" check loses: both read, both find nothing, both insert. A unique index does
-- not have that window.
--
-- Partial because the ID is optional. A plain UNIQUE would be satisfied by many NULLs in Postgres,
-- but stating WHERE national_id IS NOT NULL says the intent rather than relying on that.
--
-- Scoped by tenant, unlike the visits index added in PR 1: a national ID is a fact about a person,
-- and the same person may legitimately be a patient at two clinics on this platform.

ALTER TABLE "patients" ADD COLUMN "nationality" TEXT;
ALTER TABLE "patients" ADD COLUMN "passport_number" TEXT;
ALTER TABLE "patients" ADD COLUMN "governorate" TEXT;
ALTER TABLE "patients" ADD COLUMN "referral_source" TEXT;

ALTER TABLE "patients"
    ADD CONSTRAINT "patients_nationality_iso_alpha2"
    CHECK ("nationality" IS NULL OR "nationality" ~ '^[A-Z]{2}$');

CREATE UNIQUE INDEX "patients_national_id_unique_per_tenant"
    ON "patients" ("tenant_id", "national_id")
    WHERE "national_id" IS NOT NULL;
