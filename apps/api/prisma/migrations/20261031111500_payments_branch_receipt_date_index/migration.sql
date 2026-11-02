-- The payments report and overview select receipts by tenant, branch and receipt_date, a month at a time.
-- Without it a month is read through the clinic's whole year of receipts: 732 pages, 4.7 ms, against 63 and 0.2.
CREATE INDEX "payments_tenant_id_branch_id_receipt_date_idx" ON "payments" ("tenant_id", "branch_id", "receipt_date");
