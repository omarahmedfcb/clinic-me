-- Reverses 20261031111500_payments_branch_receipt_date_index: the reports fall back to a sequential scan.
DROP INDEX "payments_tenant_id_branch_id_receipt_date_idx";

DELETE FROM _prisma_migrations WHERE migration_name = '20261031111500_payments_branch_receipt_date_index';
