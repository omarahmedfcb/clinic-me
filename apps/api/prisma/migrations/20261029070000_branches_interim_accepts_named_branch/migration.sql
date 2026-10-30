-- Branches step 4b, stage 1: the interim fill and the receipt fallback act only when a row names no
-- branch, so write paths can name theirs one at a time; stage 5 drops both (BRANCHES-DESIGN §4.2).
CREATE OR REPLACE FUNCTION interim_fill_sole_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := interim_sole_branch(NEW.tenant_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

-- A named branch is kept; the composite foreign keys refuse one that disagrees with the charge, visit
-- or appointment. COALESCE stops at the first value, so the fallback is reached only with none.
CREATE OR REPLACE FUNCTION allocate_receipt_number() RETURNS TRIGGER AS $$
BEGIN
  NEW.branch_id := COALESCE(
    NEW.branch_id,
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
