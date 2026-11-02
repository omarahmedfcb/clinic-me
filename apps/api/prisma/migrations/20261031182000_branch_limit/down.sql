-- Reverses 20261031182000_branch_limit. The history goes with the table: down is for a branch never deployed.
DROP TRIGGER "branches_within_max_branches" ON "branches";
DROP FUNCTION enforce_branch_limit();
DROP TABLE "branch_limit_changes";
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_max_branches_at_least_one";
ALTER TABLE "tenants" DROP COLUMN "max_branches";

DELETE FROM _prisma_migrations WHERE migration_name = '20261031182000_branch_limit';
