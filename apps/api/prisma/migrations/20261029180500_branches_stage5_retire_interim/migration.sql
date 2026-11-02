-- Branches step 4b, stage 5: nothing fills a branch any more (BRANCHES-DESIGN §4.2). Every write path
-- names its branch; a row that names none is refused by NOT NULL, or here for a receipt paying for nothing.
DROP TRIGGER "appointments_interim_fill_sole_branch" ON "appointments";
DROP TRIGGER "schedule_templates_interim_fill_sole_branch" ON "schedule_templates";
DROP FUNCTION interim_fill_sole_branch();

CREATE OR REPLACE FUNCTION allocate_receipt_number() RETURNS TRIGGER AS $$
BEGIN
  NEW.branch_id := COALESCE(
    NEW.branch_id,
    (SELECT c.branch_id FROM visit_charges c WHERE c.id = NEW.charge_id),
    (SELECT v.branch_id FROM visits v WHERE v.id = NEW.visit_id),
    (SELECT a.branch_id FROM appointments a WHERE a.id = NEW.appointment_id)
  );

  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'A receipt names no charge, visit or appointment, and no branch: there is no branch to number it in.';
  END IF;

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

DROP FUNCTION interim_sole_branch(uuid, text);
