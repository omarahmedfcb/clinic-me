-- Branches, A2: the schema and the backfill (docs/BRANCHES-DESIGN.md §1–2). One file, one transaction:
-- every clinic gets one default branch, every operational row is stamped with it, and the receipt
-- counter continues where the clinic's stopped. down.sql beside this file reverses it, and refuses
-- once a clinic has a second branch or an invoice number has been issued.

-- A role that cannot bypass RLS sees no clinic, so the backfill and every assertion below would pass
-- on nothing. Refuse rather than report a vacuous success.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = 'tenants' AND n_live_tup > 0) THEN
    RAISE EXCEPTION 'branches migration: % cannot see clinics through RLS, so the backfill would touch nothing. Run it as the migration superuser.', current_user;
  END IF;
END $$;

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

-- ---------------------------------------------------------------------------------------------
-- 1. Enums and the three new tables.

CREATE TYPE "BranchStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "BranchScope" AS ENUM ('ALL', 'SELECTED', 'SCHEDULED');
CREATE TYPE "BranchRequestKind" AS ENUM ('CREATE');
CREATE TYPE "BranchRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT,
    "address" TEXT NOT NULL,
    "address_en" TEXT,
    "phone" TEXT NOT NULL,
    "secondary_phone" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "printed_working_hours" TEXT,
    "receipt_prefix" TEXT,
    "invoice_prefix" TEXT,
    "next_receipt_number" INTEGER NOT NULL DEFAULT 1,
    "next_invoice_number" INTEGER NOT NULL DEFAULT 1,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "BranchStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspension_reason" TEXT,
    "suspended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branches_suspension_explained"
        CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL AND "suspension_reason" IS NOT NULL)),
    CONSTRAINT "branches_coordinates_paired" CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
    CONSTRAINT "branches_counters_positive" CHECK ("next_receipt_number" > 0 AND "next_invoice_number" > 0),
    CONSTRAINT "branches_prefixes_not_blank"
        CHECK (("receipt_prefix" IS NULL OR btrim("receipt_prefix") <> '') AND ("invoice_prefix" IS NULL OR btrim("invoice_prefix") <> ''))
);

-- The target of every composite foreign key: (tenant_id, branch_id) can only name this clinic's branch.
CREATE UNIQUE INDEX "branches_tenant_id_id_key" ON "branches"("tenant_id", "id");
CREATE UNIQUE INDEX "branches_one_default_per_tenant" ON "branches"("tenant_id") WHERE "is_default";
CREATE UNIQUE INDEX "branches_one_unprefixed_receipts_per_tenant" ON "branches"("tenant_id") WHERE "receipt_prefix" IS NULL;
CREATE UNIQUE INDEX "branches_one_unprefixed_invoices_per_tenant" ON "branches"("tenant_id") WHERE "invoice_prefix" IS NULL;
CREATE UNIQUE INDEX "branches_tenant_id_receipt_prefix_key" ON "branches"("tenant_id", "receipt_prefix");
CREATE UNIQUE INDEX "branches_tenant_id_invoice_prefix_key" ON "branches"("tenant_id", "invoice_prefix");
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- membership_branches names a membership of the same clinic, so memberships gains the pair as a key.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_id_key" UNIQUE ("tenant_id", "id");

CREATE TABLE "membership_branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_branches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "membership_branches_tenant_id_idx" ON "membership_branches"("tenant_id");
CREATE UNIQUE INDEX "membership_branches_membership_id_branch_id_key" ON "membership_branches"("membership_id", "branch_id");
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_membership_id_fkey"
    FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_tenant_id_membership_id_fkey"
    FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id");
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "branch_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "BranchRequestKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BranchRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "created_branch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "branch_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_requests_decided_iff_not_pending" CHECK (("status" = 'PENDING') = ("decided_by" IS NULL)),
    CONSTRAINT "branch_requests_decided_at_with_decider" CHECK (("decided_by" IS NULL) = ("decided_at" IS NULL)),
    CONSTRAINT "branch_requests_rejection_has_reason" CHECK ("status" <> 'REJECTED' OR "decision_reason" IS NOT NULL),
    CONSTRAINT "branch_requests_approval_names_branch" CHECK (("status" = 'APPROVED') = ("created_branch_id" IS NOT NULL))
);
CREATE INDEX "branch_requests_tenant_id_status_idx" ON "branch_requests"("tenant_id", "status");
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_decided_by_fkey"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "branch_requests" ADD CONSTRAINT "branch_requests_tenant_id_created_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "created_branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS, grants and the audit trigger: the complaints pattern, on all three.
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branches
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branches TO clinic_os_app;
CREATE TRIGGER branches_audit AFTER INSERT OR UPDATE OR DELETE ON branches
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE membership_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_branches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_branches
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
-- DELETE, unlike the financial tables: narrowing a receptionist's branches removes a row.
GRANT SELECT, INSERT, DELETE ON membership_branches TO clinic_os_app;
CREATE TRIGGER membership_branches_audit AFTER INSERT OR UPDATE OR DELETE ON membership_branches
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE branch_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branch_requests TO clinic_os_app;
CREATE TRIGGER branch_requests_audit AFTER INSERT OR UPDATE OR DELETE ON branch_requests
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- IF NOT EXISTS: down.sql keeps this column, because audit rows written in between may carry a branch.
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "branch_id" UUID;
ALTER TABLE "tenants" ADD COLUMN "branches_enabled_at" TIMESTAMPTZ(6);
UPDATE tenants SET branches_enabled_at = now();

-- ---------------------------------------------------------------------------------------------
-- 2. One default branch per clinic. Its receipt counter is the clinic's, so the next receipt is the
-- one that would have come next; both prefixes are null, so nothing printed changes.

INSERT INTO branches (
  id, tenant_id, name, name_en, address, address_en, phone, secondary_phone, printed_working_hours,
  next_receipt_number, next_invoice_number, is_default, status, created_at, updated_at
)
SELECT uuid_generate_v7(), t.id, t.name, t.name_en, t.address, t.address_en, t.phone, t.secondary_phone,
       t.printed_working_hours, t.next_receipt_number, 1, true, 'ACTIVE', now(), now()
  FROM tenants t;

-- ---------------------------------------------------------------------------------------------
-- 3. The stamped columns, nullable until the backfill fills them.

ALTER TABLE "schedule_templates" ADD COLUMN "branch_id" UUID;
ALTER TABLE "schedule_exceptions" ADD COLUMN "branch_id" UUID;
ALTER TABLE "appointments" ADD COLUMN "branch_id" UUID;
ALTER TABLE "visits" ADD COLUMN "branch_id" UUID;
ALTER TABLE "visit_charges" ADD COLUMN "branch_id" UUID, ADD COLUMN "invoice_number" INTEGER;
ALTER TABLE "payments" ADD COLUMN "branch_id" UUID;

-- ---------------------------------------------------------------------------------------------
-- 4. Backfill, parents first, so each composite foreign key below finds its parent stamped.
-- schedule_exceptions stay null: an existing closure applied to the whole clinic, i.e. every branch.

UPDATE schedule_templates x SET branch_id = b.id
  FROM branches b WHERE b.tenant_id = x.tenant_id AND b.is_default;
UPDATE appointments x SET branch_id = b.id
  FROM branches b WHERE b.tenant_id = x.tenant_id AND b.is_default;
UPDATE visits v SET branch_id = a.branch_id
  FROM appointments a WHERE a.id = v.appointment_id;
UPDATE visit_charges c SET branch_id = v.branch_id
  FROM visits v WHERE v.id = c.visit_id;
UPDATE payments p SET branch_id = COALESCE(
  (SELECT c.branch_id FROM visit_charges c WHERE c.id = p.charge_id),
  (SELECT v.branch_id FROM visits v WHERE v.id = p.visit_id),
  (SELECT a.branch_id FROM appointments a WHERE a.id = p.appointment_id),
  (SELECT b.id FROM branches b WHERE b.tenant_id = p.tenant_id AND b.is_default)
);

-- Number the charges already written, per branch, oldest first; the counter continues above them.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY branch_id ORDER BY created_at, id) AS n FROM visit_charges
)
UPDATE visit_charges c SET invoice_number = numbered.n FROM numbered WHERE c.id = numbered.id;
UPDATE branches b SET next_invoice_number = COALESCE(
  (SELECT max(c.invoice_number) + 1 FROM visit_charges c WHERE c.branch_id = b.id), 1
);

-- Asserted here, before NOT NULL, so a gap in the backfill is reported as one rather than as a
-- constraint error on whichever table happens to be altered first.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT (SELECT count(*) FROM schedule_templates WHERE branch_id IS NULL)
       + (SELECT count(*) FROM appointments WHERE branch_id IS NULL)
       + (SELECT count(*) FROM visits WHERE branch_id IS NULL)
       + (SELECT count(*) FROM visit_charges WHERE branch_id IS NULL OR invoice_number IS NULL)
       + (SELECT count(*) FROM payments WHERE branch_id IS NULL)
    INTO v_bad;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % rows still have no branch after the backfill', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Currency on the five ledger tables. The three ordinary ones are updated from the clinic.

ALTER TABLE "visit_charges" ADD COLUMN "currency" CHAR(3);
ALTER TABLE "visit_charge_lines" ADD COLUMN "currency" CHAR(3);
ALTER TABLE "payments" ADD COLUMN "currency" CHAR(3);
UPDATE visit_charges x SET currency = t.currency FROM tenants t WHERE t.id = x.tenant_id;
UPDATE visit_charge_lines x SET currency = t.currency FROM tenants t WHERE t.id = x.tenant_id;
UPDATE payments x SET currency = t.currency FROM tenants t WHERE t.id = x.tenant_id;

-- payment_adjustments and patient_credits are append-only, and that guard is never disabled. Their
-- old rows take a constant column default, which writes no row and fires no trigger, and is only
-- honest because the clinics owning rows there are asserted to share one currency.
DO $$
DECLARE
  v_currencies int;
  v_currency   text;
BEGIN
  SELECT count(DISTINCT t.currency), min(t.currency) INTO v_currencies, v_currency
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM payment_adjustments a WHERE a.tenant_id = t.id)
      OR EXISTS (SELECT 1 FROM patient_credits c WHERE c.tenant_id = t.id);
  IF v_currencies > 1 THEN
    RAISE EXCEPTION 'branches migration: append-only money rows belong to clinics in % currencies; one column default cannot be true for all of them', v_currencies;
  END IF;
  -- 'XXX' is ISO 4217 for "no currency": used only when both tables are empty, and dropped below.
  EXECUTE format('ALTER TABLE payment_adjustments ADD COLUMN currency CHAR(3) NOT NULL DEFAULT %L', COALESCE(v_currency, 'XXX'));
  EXECUTE format('ALTER TABLE patient_credits ADD COLUMN currency CHAR(3) NOT NULL DEFAULT %L', COALESCE(v_currency, 'XXX'));
END $$;
ALTER TABLE payment_adjustments ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE patient_credits ALTER COLUMN currency DROP DEFAULT;

-- ---------------------------------------------------------------------------------------------
-- 6. Constraints, now that every row is filled.

ALTER TABLE "schedule_templates" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "appointments" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "visits" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "visit_charges" ALTER COLUMN "branch_id" SET NOT NULL, ALTER COLUMN "invoice_number" SET NOT NULL,
  ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "visit_charge_lines" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "branch_id" SET NOT NULL, ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "visit_charges" ADD CONSTRAINT "visit_charges_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "visit_charge_lines" ADD CONSTRAINT "visit_charge_lines_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payment_adjustments" ADD CONSTRAINT "payment_adjustments_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "patient_credits" ADD CONSTRAINT "patient_credits_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Tenant-composite foreign keys: the database refuses a row naming another clinic's branch.
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visits" ADD CONSTRAINT "visits_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charges" ADD CONSTRAINT "visit_charges_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Parent-composite foreign keys: a child cannot sit in a different branch from its parent.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_id_branch_id_key" UNIQUE ("id", "branch_id");
ALTER TABLE "visits" ADD CONSTRAINT "visits_id_branch_id_key" UNIQUE ("id", "branch_id");
ALTER TABLE "visit_charges" ADD CONSTRAINT "visit_charges_id_branch_id_key" UNIQUE ("id", "branch_id");
ALTER TABLE "visits" ADD CONSTRAINT "visits_appointment_id_branch_id_fkey"
    FOREIGN KEY ("appointment_id", "branch_id") REFERENCES "appointments"("id", "branch_id");
ALTER TABLE "visit_charges" ADD CONSTRAINT "visit_charges_visit_id_branch_id_fkey"
    FOREIGN KEY ("visit_id", "branch_id") REFERENCES "visits"("id", "branch_id");
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_id_branch_id_fkey"
    FOREIGN KEY ("charge_id", "branch_id") REFERENCES "visit_charges"("id", "branch_id");
ALTER TABLE "payments" ADD CONSTRAINT "payments_visit_id_branch_id_fkey"
    FOREIGN KEY ("visit_id", "branch_id") REFERENCES "visits"("id", "branch_id");
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_branch_id_fkey"
    FOREIGN KEY ("appointment_id", "branch_id") REFERENCES "appointments"("id", "branch_id");

-- Numbers are unique per branch. The replacement exists before the per-clinic index goes.
CREATE UNIQUE INDEX "payments_branch_id_receipt_number_key" ON "payments" ("branch_id", "receipt_number");
DROP INDEX "payments_tenant_id_receipt_number_key";
CREATE UNIQUE INDEX "visit_charges_branch_id_invoice_number_key" ON "visit_charges" ("branch_id", "invoice_number");
ALTER TABLE "visit_charges" ADD CONSTRAINT "visit_charges_invoice_number_positive" CHECK ("invoice_number" > 0);

-- ---------------------------------------------------------------------------------------------
-- 7. Triggers.

-- INTERIM — remove in branches step 4, when write paths choose the branch. Until then a new row
-- takes the clinic's only active branch, and an insert that chose its own branch is refused, so
-- this cannot linger silently once write paths exist (branches-interim.integration.spec.ts).
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
  IF NEW.branch_id IS NOT NULL THEN
    RAISE EXCEPTION 'interim_fill_sole_branch is still installed on %, but this insert chose its own branch. Write paths set the branch now: drop the interim triggers (branches step 4).', TG_TABLE_NAME;
  END IF;
  NEW.branch_id := interim_sole_branch(NEW.tenant_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_templates_interim_fill_sole_branch BEFORE INSERT ON schedule_templates
  FOR EACH ROW EXECUTE FUNCTION interim_fill_sole_branch();
CREATE TRIGGER appointments_interim_fill_sole_branch BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION interim_fill_sole_branch();

-- Permanent: a visit is in its appointment's branch. The composite FK refuses any other value.
CREATE FUNCTION stamp_visit_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    SELECT a.branch_id INTO NEW.branch_id FROM appointments a WHERE a.id = NEW.appointment_id;
  END IF;
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'stamp_visit_branch: no appointment % to take a branch from', NEW.appointment_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visits_stamp_branch BEFORE INSERT ON visits
  FOR EACH ROW EXECUTE FUNCTION stamp_visit_branch();

-- The invoice number, allocated like the receipt number: a counter column bumped under the branch
-- row's lock inside the writing transaction, so a rollback takes the increment with it (gapless).
CREATE FUNCTION allocate_invoice_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    SELECT v.branch_id INTO NEW.branch_id FROM visits v WHERE v.id = NEW.visit_id;
  END IF;
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'allocate_invoice_number: no visit % to take a branch from', NEW.visit_id;
  END IF;

  IF NEW.invoice_number IS NULL THEN
    UPDATE branches
       SET next_invoice_number = next_invoice_number + 1
     WHERE id = NEW.branch_id AND tenant_id = NEW.tenant_id
    RETURNING next_invoice_number - 1 INTO NEW.invoice_number;
  END IF;
  IF NEW.invoice_number IS NULL THEN
    RAISE EXCEPTION 'No branch row to allocate an invoice number from: %', NEW.branch_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visit_charges_allocate_invoice_number BEFORE INSERT ON visit_charges
  FOR EACH ROW EXECUTE FUNCTION allocate_invoice_number();

-- The receipt number now comes from the branch row, not the tenant row. The branch is the charge's,
-- else the visit's, else the appointment's; with none of them (a top-up), INTERIM: the only branch.
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

-- A money row keeps the currency it was taken in.
CREATE FUNCTION stamp_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT t.currency INTO NEW.currency FROM tenants t WHERE t.id = NEW.tenant_id;
  END IF;
  IF NEW.currency IS NULL THEN
    RAISE EXCEPTION 'stamp_currency: no clinic % to take a currency from', NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visit_charges_stamp_currency BEFORE INSERT ON visit_charges
  FOR EACH ROW EXECUTE FUNCTION stamp_currency();
CREATE TRIGGER visit_charge_lines_stamp_currency BEFORE INSERT ON visit_charge_lines
  FOR EACH ROW EXECUTE FUNCTION stamp_currency();
CREATE TRIGGER payments_stamp_currency BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION stamp_currency();
CREATE TRIGGER payment_adjustments_stamp_currency BEFORE INSERT ON payment_adjustments
  FOR EACH ROW EXECUTE FUNCTION stamp_currency();
CREATE TRIGGER patient_credits_stamp_currency BEFORE INSERT ON patient_credits
  FOR EACH ROW EXECUTE FUNCTION stamp_currency();

-- THE SINGLE SANCTIONED PLACE WHERE A TENANT BINDS ITSELF (ruled 2026-10-27). Nothing else in database
-- code may set app.current_tenant_id; tenant-self-binding.spec.ts fails if the pattern appears elsewhere.
-- Every clinic created from now on gets its default branch in the same transaction, whichever path
-- creates it. Clinic creation is unbound, so the new clinic's own id is bound for this one insert,
-- and with no actor bound (a fixture, the seed) the branch is the system's doing and says so.
CREATE FUNCTION create_default_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bound text := current_setting('app.current_tenant_id', true);
  v_actor text := current_setting('app.current_actor_id', true);
BEGIN
  PERFORM set_config('app.current_tenant_id', NEW.id::text, true);
  IF NULLIF(v_actor, '') IS NULL THEN
    PERFORM set_config('app.current_actor_id', system_actor_id()::text, true);
  END IF;
  INSERT INTO branches (
    id, tenant_id, name, name_en, address, address_en, phone, secondary_phone, printed_working_hours,
    next_receipt_number, next_invoice_number, is_default, status, created_at, updated_at
  ) VALUES (
    uuid_generate_v7(), NEW.id, NEW.name, NEW.name_en, NEW.address, NEW.address_en, NEW.phone,
    NEW.secondary_phone, NEW.printed_working_hours, NEW.next_receipt_number, 1, true, 'ACTIVE', now(), now()
  );
  PERFORM set_config('app.current_tenant_id', COALESCE(v_bound, ''), true);
  PERFORM set_config('app.current_actor_id', COALESCE(v_actor, ''), true);
  RETURN NULL;
END;
$$;
CREATE TRIGGER tenants_create_default_branch AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION create_default_branch();

-- Membership scope follows the role unless it is set explicitly: ruled defaults.
CREATE FUNCTION default_branch_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.branch_scope IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.role = OLD.role OR NEW.branch_scope IS DISTINCT FROM OLD.branch_scope) THEN
    RETURN NEW;
  END IF;
  NEW.branch_scope := CASE NEW.role
    WHEN 'DOCTOR' THEN 'SCHEDULED'
    WHEN 'RECEPTIONIST' THEN 'SELECTED'
    ELSE 'ALL'
  END::"BranchScope";
  RETURN NEW;
END;
$$;

-- A SELECTED membership with no branch could work nowhere; it starts in the default branch.
CREATE FUNCTION default_membership_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_scope = 'SELECTED'
     AND NOT EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = NEW.id) THEN
    INSERT INTO membership_branches (id, tenant_id, membership_id, branch_id, created_at)
    SELECT uuid_generate_v7(), NEW.tenant_id, NEW.id, b.id, now()
      FROM branches b WHERE b.tenant_id = NEW.tenant_id AND b.is_default;
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Membership scope, backfilled by role, then held there by the two triggers above.

ALTER TABLE "memberships" ADD COLUMN "branch_scope" "BranchScope";
UPDATE memberships SET branch_scope = CASE role
  WHEN 'DOCTOR' THEN 'SCHEDULED'
  WHEN 'RECEPTIONIST' THEN 'SELECTED'
  ELSE 'ALL'
END::"BranchScope";
ALTER TABLE "memberships" ALTER COLUMN "branch_scope" SET NOT NULL;

INSERT INTO membership_branches (id, tenant_id, membership_id, branch_id, created_at)
SELECT uuid_generate_v7(), m.tenant_id, m.id, b.id, now()
  FROM memberships m JOIN branches b ON b.tenant_id = m.tenant_id AND b.is_default
 WHERE m.branch_scope = 'SELECTED';

CREATE TRIGGER memberships_default_branch_scope BEFORE INSERT OR UPDATE OF role ON memberships
  FOR EACH ROW EXECUTE FUNCTION default_branch_scope();
CREATE TRIGGER memberships_default_branch AFTER INSERT OR UPDATE OF role, branch_scope ON memberships
  FOR EACH ROW EXECUTE FUNCTION default_membership_branch();

-- ---------------------------------------------------------------------------------------------
-- 9. The audit trail records the branch: the audited row's own, else the one the request bound.
-- Old rows are not touched (append-only); they read as the default branch by branches_enabled_at.

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
  v_branch_id  uuid;
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

  v_branch_id := COALESCE(
    NULLIF(COALESCE(v_new, v_previous)->>'branch_id', '')::uuid,
    NULLIF(current_setting('app.current_branch_id', true), '')::uuid
  );

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
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at, branch_id
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
    now(),
    v_branch_id
  );

  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 10. Assertions. Any failure raises, and the whole migration rolls back with it.

DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM tenants t
   WHERE (SELECT count(*) FROM branches b WHERE b.tenant_id = t.id) <> 1
      OR (SELECT count(*) FROM branches b WHERE b.tenant_id = t.id AND b.is_default) <> 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % clinics do not have exactly one branch, as their default', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM branches b JOIN tenants t ON t.id = b.tenant_id
   WHERE b.next_receipt_number <> t.next_receipt_number
      OR b.next_receipt_number <= COALESCE((SELECT max(p.receipt_number) FROM payments p WHERE p.branch_id = b.id), 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % branches would not issue the receipt number that comes next', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM branches b
   WHERE b.next_invoice_number <= COALESCE((SELECT max(c.invoice_number) FROM visit_charges c WHERE c.branch_id = b.id), 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % branches would reissue an invoice number', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM memberships m
   WHERE m.branch_scope = 'SELECTED' AND NOT EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = m.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % selected-scope memberships have no branch', v_bad;
  END IF;

  SELECT (SELECT count(*) FROM visit_charges x JOIN tenants t ON t.id = x.tenant_id WHERE x.currency <> t.currency)
       + (SELECT count(*) FROM visit_charge_lines x JOIN tenants t ON t.id = x.tenant_id WHERE x.currency <> t.currency)
       + (SELECT count(*) FROM payments x JOIN tenants t ON t.id = x.tenant_id WHERE x.currency <> t.currency)
       + (SELECT count(*) FROM payment_adjustments x JOIN tenants t ON t.id = x.tenant_id WHERE x.currency <> t.currency)
       + (SELECT count(*) FROM patient_credits x JOIN tenants t ON t.id = x.tenant_id WHERE x.currency <> t.currency)
    INTO v_bad;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'branches migration: % money rows carry a currency other than their clinic''s', v_bad;
  END IF;
END $$;

SELECT set_config('app.current_actor_id', '', false);
