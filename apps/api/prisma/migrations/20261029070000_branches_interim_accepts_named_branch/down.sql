-- Reverses 20261029070000_branches_interim_accepts_named_branch: restores both functions exactly as
-- 20261027100000_branches defined them (compared byte for byte by branches-down-migration.spec.ts).
CREATE OR REPLACE FUNCTION interim_fill_sole_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NOT NULL THEN
    RAISE EXCEPTION 'interim_fill_sole_branch is still installed on %, but this insert chose its own branch. Write paths set the branch now: drop the interim triggers (branches step 4).', TG_TABLE_NAME;
  END IF;
  NEW.branch_id := interim_sole_branch(NEW.tenant_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION allocate_receipt_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.branch_id IS NOT NULL THEN
    RAISE EXCEPTION 'allocate_receipt_number still carries the interim branch fallback, but this insert chose its own branch. Write paths set the branch now: remove the fallback (branches step 4).';
  END IF;
  NEW.branch_id := COALESCE(
    (SELECT c.branch_id FROM visit_charges c WHERE c.id = NEW.charge_id),
    (SELECT v.branch_id FROM visits v WHERE v.id = NEW.visit_id),
    (SELECT a.branch_id FROM appointments a WHERE a.id = NEW.appointment_id),
    interim_sole_branch(NEW.tenant_id, TG_TABLE_NAME)
  );

  IF NEW.receipt_number IS NULL THEN
    UPDATE branches
       SET next_receipt_number = next_receipt_number + 1
     WHERE id = NEW.branch_id AND tenant_id = NEW.tenant_id
    RETURNING next_receipt_number - 1 INTO NEW.receipt_number;
  END IF;

  IF NEW.receipt_number IS NULL THEN
    RAISE EXCEPTION 'No branch row to allocate a receipt number from: %', NEW.branch_id;
  END IF;

  IF NEW.receipt_date IS NULL THEN
    NEW.receipt_date := COALESCE(NEW.paid_at::date, CURRENT_DATE);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DELETE FROM _prisma_migrations WHERE migration_name = '20261029070000_branches_interim_accepts_named_branch';
