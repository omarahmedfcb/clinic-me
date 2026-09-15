-- Phase 5, PR 3 — the charge tables C rests on. `PHASE-5-PLAN.md` PR 3, `PHASE-5-DESIGN.md` §4.1.
--
-- ## Three tables, because `payments` is currently two things
--
-- A `payments` row today carries `service_price_minor` and `discount_amount_minor` (invoice
-- concepts) beside `method`, `paid_at` and `collected_by_user_id` (receipt concepts). One such row
-- cannot represent three procedures, and cannot represent two part-payments taken in cash and then
-- by Instapay. `visit_charges` is what the visit costs, `visit_charge_lines` is what it is made of,
-- and `payments` becomes the receipt — that last step is PR 5, not this migration.
--
-- ## Not `Invoice`
--
-- `Invoice` is taken: it is SaaS subscription billing (`PHASE-5-DESIGN.md` §1.2). Reusing the name
-- for the clinical document would put two unrelated things one word apart in every future query.
--
-- ## No `patient_due_minor` column
--
-- §1.1 records that this column does not exist and should not be reintroduced. The patient's share
-- is `subtotal - discount - payer_share`, and it is computed by the view at the bottom of this
-- file. D7, as amended on 2026-09-03, requires derived money to be database-computed rather than
-- specifically `GENERATED` — which is what makes a view the right answer here, since the balance is
-- a sum across payment rows and no generated column can express a cross-table aggregate.

CREATE TYPE "ChargeStatus" AS ENUM ('OPEN', 'SETTLED', 'VOID');
CREATE TYPE "ChargeLineSource" AS ENUM ('CATALOGUE', 'AD_HOC', 'MATERIAL');

-- ---------------------------------------------------------------------------------------------
-- Materials a visit can be charged for. Deliberately NOT rows in `services`.

CREATE TABLE "chargeable_materials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "unit" TEXT NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "chargeable_materials_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "chargeable_materials"
    ADD CONSTRAINT "chargeable_materials_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Free is a real price for a material a clinic absorbs; negative is not a price.
ALTER TABLE "chargeable_materials"
    ADD CONSTRAINT "chargeable_materials_price_not_negative" CHECK ("price_minor" >= 0);

CREATE UNIQUE INDEX "chargeable_materials_tenant_id_name_key"
    ON "chargeable_materials" ("tenant_id", lower("name_ar"));

CREATE INDEX "chargeable_materials_tenant_id_is_active_idx"
    ON "chargeable_materials" ("tenant_id", "is_active");

-- ---------------------------------------------------------------------------------------------
-- What a completed visit costs.

CREATE TABLE "visit_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'OPEN',
    "subtotal_minor" INTEGER NOT NULL DEFAULT 0,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    -- What an insurer or employer is expected to pay. Set by hand in PR 7: there is no coverage
    -- rate in this schema, and automating a split against a rate nobody entered is a guess.
    "payer_share_minor" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "visit_charges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One charge per visit. Not one per appointment: a visit is what gets completed, and Q15 already
-- allows several visit rows against one appointment with one of them completed.
CREATE UNIQUE INDEX "visit_charges_visit_id_key" ON "visit_charges" ("visit_id");
CREATE INDEX "visit_charges_tenant_id_status_idx" ON "visit_charges" ("tenant_id", "status");

ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_amounts_not_negative"
    CHECK ("subtotal_minor" >= 0 AND "discount_minor" >= 0 AND "payer_share_minor" >= 0);

-- A discount cannot exceed what is being discounted, and the payer cannot be asked for more than
-- remains after it. Together these keep the patient's share -- which the view computes -- at zero
-- or above, so no screen ever has to render a negative amount due and decide what it means.
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_discount_within_subtotal"
    CHECK ("discount_minor" <= "subtotal_minor");
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_payer_share_within_remainder"
    CHECK ("payer_share_minor" <= "subtotal_minor" - "discount_minor");

-- A reason is not optional once money comes off. Ruling 4 puts a ceiling on who may discount how
-- much; this is the smaller rule that an unexplained discount is not a discount.
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_discount_has_a_reason"
    CHECK ("discount_minor" = 0 OR "discount_reason" IS NOT NULL);

ALTER TABLE visit_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_charges
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER visit_charges_audit
  AFTER INSERT OR UPDATE OR DELETE ON visit_charges
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ---------------------------------------------------------------------------------------------
-- What the charge is made of.

CREATE TABLE "visit_charge_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    -- **Snapshots, not joins.** The name and the price are frozen at completion; re-joining to
    -- `services` would make every historical charge move the moment an admin edits a price, which
    -- is the same rule `appointments.quoted_price_minor` exists for.
    "name_snapshot" TEXT NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" "ChargeLineSource" NOT NULL,
    -- A doctor-priced ad-hoc line is flagged and the invoice proceeds anyway (ruling 2). Admin
    -- reviews it afterwards; nothing waits on that.
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    -- Where the line came from, for the review queue and for a future inventory module. Nullable:
    -- an ad-hoc line points at neither.
    "service_id" UUID,
    "material_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "visit_charge_lines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_charge_id_fkey"
    FOREIGN KEY ("charge_id") REFERENCES "visit_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_service_id_fkey"
    FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "chargeable_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "visit_charge_lines_tenant_id_charge_id_idx"
    ON "visit_charge_lines" ("tenant_id", "charge_id");
-- The review queue's own read: every flagged line in a clinic, without scanning the table.
CREATE INDEX "visit_charge_lines_needs_review_idx"
    ON "visit_charge_lines" ("tenant_id") WHERE "needs_review";

ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_price_not_negative" CHECK ("unit_price_minor" >= 0);

-- The discriminator has to agree with what the line points at, or `source` is decoration and the
-- future inventory module reading MATERIAL lines gets procedures.
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_source_matches_origin"
    CHECK (
      ("source" = 'CATALOGUE' AND "service_id" IS NOT NULL AND "material_id" IS NULL)
      OR ("source" = 'MATERIAL' AND "material_id" IS NOT NULL AND "service_id" IS NULL)
      OR ("source" = 'AD_HOC' AND "service_id" IS NULL AND "material_id" IS NULL)
    );

ALTER TABLE visit_charge_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_charge_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_charge_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER visit_charge_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON visit_charge_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE chargeable_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE chargeable_materials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chargeable_materials
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER chargeable_materials_audit
  AFTER INSERT OR UPDATE OR DELETE ON chargeable_materials
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ---------------------------------------------------------------------------------------------
-- The balance. Ruling 3: a view, and D7 amended to say "database-computed" rather than "GENERATED".
--
-- **`security_invoker = true` is load-bearing and is not a style choice.** Without it a view runs
-- with its owner's rights, and the owner is the migration superuser — so every row of every clinic
-- would come back through this view regardless of `app.current_tenant_id`. With it, the underlying
-- tables' RLS policies are evaluated as the querying role, which is the whole tenant boundary.
CREATE VIEW visit_charge_balances WITH (security_invoker = true) AS
SELECT
  c.id                AS charge_id,
  c.tenant_id,
  c.visit_id,
  c.patient_id,
  c.status,
  c.subtotal_minor,
  c.discount_minor,
  c.payer_share_minor,
  (c.subtotal_minor - c.discount_minor - c.payer_share_minor) AS patient_share_minor,
  COALESCE(p.paid_minor, 0) AS paid_minor,
  (c.subtotal_minor - c.discount_minor - c.payer_share_minor) - COALESCE(p.paid_minor, 0)
                      AS balance_minor
FROM visit_charges c
LEFT JOIN (
  SELECT visit_id, tenant_id, SUM(amount_paid_minor)::int AS paid_minor
    FROM payments
   WHERE visit_id IS NOT NULL
   GROUP BY visit_id, tenant_id
) p ON p.visit_id = c.visit_id AND p.tenant_id = c.tenant_id;
