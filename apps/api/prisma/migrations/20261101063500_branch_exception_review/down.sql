-- Reverses 20261101063500_branch_exception_review. Exceptions copied by a decision stay: they are ordinary exceptions.
DROP TABLE "branch_exception_reviews";
DROP TYPE "ExceptionReviewDecision";

DELETE FROM _prisma_migrations WHERE migration_name = '20261101063500_branch_exception_review';
