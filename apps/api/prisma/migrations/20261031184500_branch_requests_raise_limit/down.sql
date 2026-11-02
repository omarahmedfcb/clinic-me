-- Reverses 20261031184500_branch_requests_raise_limit. Refuses over rows, as the up does: their shapes do not convert.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM branch_requests) THEN
    RAISE EXCEPTION 'branch requests down: branch_requests holds raise-limit rows, which the old CREATE shape cannot hold.';
  END IF;
END $$;

DROP FUNCTION platform_branch_requests();
DROP POLICY definer_reads ON branches;
DROP POLICY definer_reads ON branch_requests;
REVOKE SELECT ON branch_requests, branches FROM clinic_os_definer;
DROP INDEX "branch_requests_one_pending_per_tenant";
ALTER TABLE "branch_requests" DROP CONSTRAINT "branch_requests_limit_change_id_fkey";
ALTER TABLE "branch_requests" DROP CONSTRAINT "branch_requests_approval_names_limit_change";
ALTER TABLE "branch_requests" DROP CONSTRAINT "branch_requests_requested_limit_at_least_two";
ALTER TABLE "branch_requests" DROP COLUMN "limit_change_id", DROP COLUMN "note", DROP COLUMN "requested_limit";

CREATE TYPE "BranchRequestKind" AS ENUM ('CREATE');
ALTER TABLE "branch_requests"
  ADD COLUMN "kind" "BranchRequestKind" NOT NULL,
  ADD COLUMN "payload" JSONB NOT NULL,
  ADD COLUMN "created_branch_id" UUID;
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_tenant_id_created_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "created_branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_approval_names_branch"
    CHECK (("status" = 'APPROVED') = ("created_branch_id" IS NOT NULL));

DELETE FROM _prisma_migrations WHERE migration_name = '20261031184500_branch_requests_raise_limit';
