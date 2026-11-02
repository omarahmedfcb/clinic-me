-- Reverses 20261029180500_branches_stage5_retire_interim: the interim fill and the receipt fallback come back
-- exactly as stage 1 left them (compared byte for byte by branches-down-migration.spec.ts).
CREATE FUNCTION interim_sole_branch(p_tenant_id uuid, p_table text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_count  int;
  v_branch text;
BEGIN
  SELECT count(*), min(id::text) INTO v_count, v_branch
    FROM branches WHERE tenant_id = p_tenant_id AND status = 'ACTIVE';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'interim_sole_branch: clinic % has % active branches, so a % row cannot be given one. Write paths must choose the branch (branches step 4).',
      p_tenant_id, v_count, p_table;
  END IF;
  RETURN v_branch::uuid;
END;
$$;

CREATE FUNCTION interim_fill_sole_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := interim_sole_branch(NEW.tenant_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_templates_interim_fill_sole_branch BEFORE INSERT ON schedule_templates
  FOR EACH ROW EXECUTE FUNCTION interim_fill_sole_branch();
CREATE TRIGGER appointments_interim_fill_sole_branch BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION interim_fill_sole_branch();

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

DELETE FROM _prisma_migrations WHERE migration_name = '20261029180500_branches_stage5_retire_interim';
