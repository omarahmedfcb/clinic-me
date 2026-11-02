-- Reverses 20261031192500_branch_limit_grace. A grace and its choices go with their tables; suspended branches stay suspended.
DROP FUNCTION platform_branch_limit_graces();
DROP FUNCTION due_branch_limit_graces(timestamptz);
DROP POLICY definer_reads ON branch_limit_graces;
REVOKE SELECT ON branch_limit_graces FROM clinic_os_definer;
DROP TABLE "branch_grace_choices";
DROP TABLE "branch_limit_graces";
DROP TYPE "BranchGraceStatus";

DELETE FROM _prisma_migrations WHERE migration_name = '20261031192500_branch_limit_grace';
