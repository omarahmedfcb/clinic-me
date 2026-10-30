-- Reverses 20261029155000_schedule_exception_scope. Extra availability keeps the default branch the
-- backfill gave it: that is where the engine placed a null-branch row anyway, so nothing changes.
ALTER TABLE "schedule_exceptions" DROP CONSTRAINT "schedule_exceptions_extra_availability_one_branch";
ALTER TABLE "schedule_exceptions" DROP CONSTRAINT "schedule_exceptions_branch_matches_scope";
ALTER TABLE "schedule_exceptions" DROP COLUMN "scope";
DROP TYPE "ExceptionScope";

DELETE FROM _prisma_migrations WHERE migration_name = '20261029155000_schedule_exception_scope';
