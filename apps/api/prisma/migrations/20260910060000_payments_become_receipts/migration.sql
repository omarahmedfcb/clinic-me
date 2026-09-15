-- Phase 5, PR 5 — `payments` becomes a receipt. `PHASE-5-PLAN.md` PR 5, `PHASE-5-DESIGN.md` §4.1.
--
-- ## What this migration is careful about
--
-- The founder's rule: **every existing `payments` row survives as a receipt, with its amount, its
-- date and its method. Nothing is dropped.** The rows that exist were written by a clinic taking
-- real money, and a migration that tidies them up is a migration that loses them.
--
-- The invoice half of those rows is not deleted either — it is **moved**. Where a payment names a
-- visit, its `service_price_minor` and `discount_amount_minor` become that visit's `visit_charges`
-- row before the columns go. `CLAUDE.md` forbids hard-deleting financial records, and dropping a
-- column whose contents live nowhere else would be exactly that.
--
-- A payment that names no visit is a pre-payment (Q19: money can arrive before an invoice exists).
-- Its amount, date and method survive as the receipt; the amount it was *expected* to settle was
-- always provisional and has no new home. Said plainly here rather than discovered later.
--
-- ## Gapless is a materially stronger guarantee than unique
--
-- A Postgres `SEQUENCE` is unique and **not** gapless: `nextval` is non-transactional, so a
-- rolled-back transaction consumes a number and leaves a hole — which is precisely what a tax
-- authority asks about. The counter here is an ordinary column incremented inside the same
-- transaction as the insert, so a rollback takes the increment with it and the next receipt reuses
-- the number the failed one would have had.
--
-- The cost is a row lock per receipt, serialising receipt creation within one clinic. That is the
-- right trade: a clinic issues receipts one at a time at a desk, and correctness here is a legal
-- property rather than a performance one.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "tenants" ADD COLUMN "next_receipt_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_next_receipt_number_positive" CHECK ("next_receipt_number" > 0);

ALTER TABLE "payments" ADD COLUMN "receipt_number" INTEGER;
ALTER TABLE "payments" ADD COLUMN "receipt_date" DATE;
-- The charge this receipt settles. NULLABLE, and that is Q19 expressed as a column: a payment can
-- arrive before the invoice exists, so a receipt can precede a charge.
ALTER TABLE "payments" ADD COLUMN "charge_id" UUID;

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_charge_id_fkey"
    FOREIGN KEY ("charge_id") REFERENCES "visit_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Move the invoice half of existing rows into `visit_charges` before the columns go.

INSERT INTO visit_charges (
  id, tenant_id, visit_id, patient_id, status, subtotal_minor, discount_minor, discount_reason,
  payer_share_minor, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  p.tenant_id,
  p.visit_id,
  p.patient_id,
  'OPEN',
  MAX(p.service_price_minor),
  -- A discount recorded per payment becomes the charge's discount. Summed rather than taken from
  -- one row: two part-payments could each carry part of it.
  LEAST(SUM(p.discount_amount_minor), MAX(p.service_price_minor)),
  MAX(p.discount_reason),
  0,
  MIN(p.created_at),
  now()
FROM payments p
WHERE p.visit_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM visit_charges c WHERE c.visit_id = p.visit_id)
GROUP BY p.tenant_id, p.visit_id, p.patient_id;

-- A discount with no reason would violate the charge's own CHECK; give the moved rows one that
-- says where they came from rather than inventing a clinical-sounding excuse.
UPDATE visit_charges
   SET discount_reason = 'Migrated from a payment row (Phase 5 PR 5)'
 WHERE discount_minor > 0 AND discount_reason IS NULL;

-- Existing payments settle the charge for their visit.
UPDATE payments p
   SET charge_id = c.id
  FROM visit_charges c
 WHERE c.visit_id = p.visit_id AND c.tenant_id = p.tenant_id AND p.visit_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Number the receipts that already exist, per clinic, oldest first.

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n
  FROM payments
)
UPDATE payments
   SET receipt_number = numbered.n,
       receipt_date = COALESCE(payments.paid_at::date, payments.created_at::date)
  FROM numbered
 WHERE payments.id = numbered.id;

UPDATE tenants SET next_receipt_number = COALESCE(
  (SELECT MAX(receipt_number) + 1 FROM payments WHERE payments.tenant_id = tenants.id),
  1
);

ALTER TABLE "payments" ALTER COLUMN "receipt_number" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "receipt_date" SET NOT NULL;

CREATE UNIQUE INDEX "payments_tenant_id_receipt_number_key"
    ON "payments" ("tenant_id", "receipt_number");
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_receipt_number_positive" CHECK ("receipt_number" > 0);

-- ---------------------------------------------------------------------------------------------
-- The invoice columns leave, now that their contents live in `visit_charges`.

-- `remaining_minor` is the GENERATED column D7 was written about. It goes because the concept has
-- moved: the balance is now a sum across payment rows, which `visit_charge_balances` computes and
-- no generated column can express. D7 as amended 2026-09-03 is what permits this.
ALTER TABLE "payments" DROP COLUMN "remaining_minor";
ALTER TABLE "payments" DROP COLUMN "service_price_minor";
ALTER TABLE "payments" DROP COLUMN "discount_amount_minor";
ALTER TABLE "payments" DROP COLUMN "discount_reason";
ALTER TABLE "payments" DROP COLUMN "amount_due_minor";

-- What is left is a money movement. `amount_paid_minor` is renamed to say so: on a receipt there
-- is one amount, and calling it "paid" invited the reading that some other part was not.
ALTER TABLE "payments" RENAME COLUMN "amount_paid_minor" TO "amount_minor";

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_amount_not_negative" CHECK ("amount_minor" >= 0);

CREATE INDEX "payments_tenant_id_charge_id_idx" ON "payments" ("tenant_id", "charge_id");

-- ---------------------------------------------------------------------------------------------
-- Allocation, as a trigger, for the reason the patient file number's is one: several code paths
-- insert a payment and an allocation living in one of them is one the others skip.

CREATE OR REPLACE FUNCTION allocate_receipt_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.receipt_number IS NULL THEN
    UPDATE tenants
       SET next_receipt_number = next_receipt_number + 1
     WHERE id = NEW.tenant_id
    RETURNING next_receipt_number - 1 INTO NEW.receipt_number;
  END IF;

  IF NEW.receipt_number IS NULL THEN
    RAISE EXCEPTION 'No tenant row to allocate a receipt number from: %', NEW.tenant_id;
  END IF;

  IF NEW.receipt_date IS NULL THEN
    NEW.receipt_date := COALESCE(NEW.paid_at::date, CURRENT_DATE);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_allocate_receipt_number
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION allocate_receipt_number();

SELECT set_config('app.current_actor_id', '', false);
