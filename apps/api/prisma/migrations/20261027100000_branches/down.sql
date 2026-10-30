-- Reverses 20261027100000_branches. Run with `npm run migrate:down -- 20261027100000_branches`, in one
-- transaction; it refuses first, before changing anything, in the two cases where reversing loses data.

DO $$
DECLARE
  v_applied timestamptz;
  v_count   bigint;
BEGIN
  SELECT count(*) INTO v_count FROM (SELECT tenant_id FROM branches GROUP BY tenant_id HAVING count(*) > 1) multi;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'branches down: % clinics have more than one branch. Their receipt sequences cannot be merged back into one, so this migration cannot be reversed.', v_count;
  END IF;

  SELECT started_at INTO v_applied FROM _prisma_migrations
   WHERE migration_name = '20261027100000_branches' AND finished_at IS NOT NULL;
  IF v_applied IS NULL THEN
    RAISE EXCEPTION 'branches down: 20261027100000_branches is not recorded as applied';
  END IF;
  SELECT count(*) INTO v_count FROM visit_charges WHERE created_at >= v_applied;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'branches down: % invoice numbers were issued after the migration. A printed invoice number is a financial record handed to a patient; dropping it is data loss, not a rollback.', v_count;
  END IF;
END $$;

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

-- The clinic's receipt counter resumes where its (only) branch had got to.
UPDATE tenants t SET next_receipt_number = b.next_receipt_number
  FROM branches b WHERE b.tenant_id = t.id AND b.is_default AND t.next_receipt_number <> b.next_receipt_number;

-- Triggers and functions.
DROP TRIGGER tenants_create_default_branch ON tenants;
DROP TRIGGER memberships_default_branch ON memberships;
DROP TRIGGER memberships_default_branch_scope ON memberships;
DROP TRIGGER schedule_templates_interim_fill_sole_branch ON schedule_templates;
DROP TRIGGER appointments_interim_fill_sole_branch ON appointments;
DROP TRIGGER visits_stamp_branch ON visits;
DROP TRIGGER visit_charges_allocate_invoice_number ON visit_charges;
DROP TRIGGER visit_charges_stamp_currency ON visit_charges;
DROP TRIGGER visit_charge_lines_stamp_currency ON visit_charge_lines;
DROP TRIGGER payments_stamp_currency ON payments;
DROP TRIGGER payment_adjustments_stamp_currency ON payment_adjustments;
DROP TRIGGER patient_credits_stamp_currency ON patient_credits;
DROP FUNCTION create_default_branch();
DROP FUNCTION default_membership_branch();
DROP FUNCTION default_branch_scope();
DROP FUNCTION interim_fill_sole_branch();
DROP FUNCTION stamp_visit_branch();
DROP FUNCTION allocate_invoice_number();
DROP FUNCTION stamp_currency();

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
DROP FUNCTION interim_sole_branch(uuid, text);

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_entity_id  uuid;
  v_action     "AuditAction";
  v_previous   jsonb;
  v_new        jsonb;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  -- D16: raise, do not silently substitute a default. This is consistent with the severity of
  -- this project's other two database guarantees -- the append-only triggers (D5) and RLS (D4,
  -- D15) do not degrade gracefully either, and an audit trail with anonymous rows in it is worth
  -- less than one that refused the write. A legitimate unattended process is not blocked by this:
  -- it binds system_actor_id() (06-system-actor.sql), the same way a human actor's id comes from
  -- a validated JWT claim.
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. Application code does this via withTenant(); '
                   'an unattended process should bind system_actor_id(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action    := 'CREATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := NULL;
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action    := 'UPDATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
  ELSE
    v_action    := 'DELETE';
    v_tenant_id := OLD.tenant_id;
    v_entity_id := OLD.id;
    v_previous  := to_jsonb(OLD);
    v_new       := NULL;
  END IF;

  -- actor_role is NOT NULL and is a database fact here, looked up rather than taken from the
  -- caller's JWT claim: a role changed mid-session would make the claim stale, and the whole
  -- point of this file is not to trust what the application says happened. The lookup is
  -- RLS-constrained like any other read of memberships -- it resolves because the session's
  -- tenant is bound, which for a tenant-scoped write it always is.
  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id
    AND m.user_id = v_actor_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    -- No active membership for this actor in this tenant. Two genuinely different cases, kept
    -- distinguishable rather than collapsed into one label: the system actor legitimately has no
    -- membership anywhere and never will, while anything else here is an anomaly worth being able
    -- to grep for later. Neither is a reason to refuse the write -- the actor is still recorded.
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    v_action,
    TG_TABLE_NAME,
    v_entity_id,
    v_previous,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

-- Constraints, in the reverse of the order they were added. The per-clinic receipt index first.
CREATE UNIQUE INDEX "payments_tenant_id_receipt_number_key" ON "payments" ("tenant_id", "receipt_number");
DROP INDEX "payments_branch_id_receipt_number_key";
DROP INDEX "visit_charges_branch_id_invoice_number_key";
ALTER TABLE "payments" DROP CONSTRAINT "payments_appointment_id_branch_id_fkey";
ALTER TABLE "payments" DROP CONSTRAINT "payments_visit_id_branch_id_fkey";
ALTER TABLE "payments" DROP CONSTRAINT "payments_charge_id_branch_id_fkey";
ALTER TABLE "visit_charges" DROP CONSTRAINT "visit_charges_visit_id_branch_id_fkey";
ALTER TABLE "visits" DROP CONSTRAINT "visits_appointment_id_branch_id_fkey";
ALTER TABLE "visit_charges" DROP CONSTRAINT "visit_charges_id_branch_id_key";
ALTER TABLE "visits" DROP CONSTRAINT "visits_id_branch_id_key";
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_id_branch_id_key";

-- Columns. Dropping one writes no row, so the append-only tables are not updated by this either.
ALTER TABLE "memberships" DROP COLUMN "branch_scope";
ALTER TABLE "payments" DROP COLUMN "branch_id", DROP COLUMN "currency";
ALTER TABLE "visit_charges" DROP COLUMN "branch_id", DROP COLUMN "invoice_number", DROP COLUMN "currency";
ALTER TABLE "visit_charge_lines" DROP COLUMN "currency";
ALTER TABLE "payment_adjustments" DROP COLUMN "currency";
ALTER TABLE "patient_credits" DROP COLUMN "currency";
ALTER TABLE "visits" DROP COLUMN "branch_id";
ALTER TABLE "appointments" DROP COLUMN "branch_id";
ALTER TABLE "schedule_exceptions" DROP COLUMN "branch_id";
ALTER TABLE "schedule_templates" DROP COLUMN "branch_id";
ALTER TABLE "tenants" DROP COLUMN "branches_enabled_at";
-- audit_logs.branch_id stays: rows written while branches existed may carry one.

DROP TABLE "branch_requests";
DROP TABLE "membership_branches";
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_tenant_id_id_key";
DROP TABLE "branches";
DROP TYPE "BranchRequestStatus";
DROP TYPE "BranchRequestKind";
DROP TYPE "BranchScope";
DROP TYPE "BranchStatus";

DELETE FROM _prisma_migrations WHERE migration_name = '20261027100000_branches';

SELECT set_config('app.current_actor_id', '', false);
