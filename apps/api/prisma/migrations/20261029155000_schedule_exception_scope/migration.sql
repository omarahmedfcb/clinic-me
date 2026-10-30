-- An exception's reach is an explicit value, so a null branch has exactly one meaning (ruled 2026-10-29):
-- `scope` is ONE_BRANCH or EVERY_BRANCH, and the database allows a null branch_id only with EVERY_BRANCH.

-- Without RLS bypass the backfill would see no clinic and every assertion would pass on nothing.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = 'tenants' AND n_live_tup > 0) THEN
    RAISE EXCEPTION 'exception scope migration: % cannot see clinics through RLS, so the backfill would touch nothing. Run it as the migration superuser.', current_user;
  END IF;
END $$;

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

CREATE TYPE "ExceptionScope" AS ENUM ('ONE_BRANCH', 'EVERY_BRANCH');
ALTER TABLE "schedule_exceptions" ADD COLUMN "scope" "ExceptionScope";

-- The backfill, where nobody can be asked. A named branch stays one branch. Extra availability says
-- where the doctor will be, so it takes the default branch, where the engine already placed it.
-- Everything else with no branch takes every branch: it fails safe, blocking rather than booking.
UPDATE "schedule_exceptions" SET "scope" = 'ONE_BRANCH' WHERE "branch_id" IS NOT NULL;
UPDATE "schedule_exceptions" e
   SET "scope" = 'ONE_BRANCH',
       "branch_id" = b."id"
  FROM "branches" b
 WHERE e."branch_id" IS NULL AND e."type" = 'EXTRA_AVAILABILITY'
   AND b."tenant_id" = e."tenant_id" AND b."is_default";
UPDATE "schedule_exceptions" SET "scope" = 'EVERY_BRANCH' WHERE "scope" IS NULL AND "branch_id" IS NULL;

DO $$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM "schedule_exceptions" WHERE "scope" IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'exception scope migration: % rows were left without a scope', v_count;
  END IF;
END $$;

ALTER TABLE "schedule_exceptions" ALTER COLUMN "scope" SET NOT NULL;
ALTER TABLE "schedule_exceptions"
  ADD CONSTRAINT "schedule_exceptions_branch_matches_scope"
    CHECK (("scope" = 'EVERY_BRANCH') = ("branch_id" IS NULL)),
  ADD CONSTRAINT "schedule_exceptions_extra_availability_one_branch"
    CHECK ("type" <> 'EXTRA_AVAILABILITY' OR "scope" = 'ONE_BRANCH');

SELECT set_config('app.current_actor_id', '', false);
