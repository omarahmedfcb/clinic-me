-- Clinic credit — ruling 5, Phase 5 PR 12. A ledger, chosen by the founder 2026-09-13.
--
-- `PHASE-5-PLAN.md` left one question open and asked for it to be settled before this was built:
-- a `patient_credits` ledger, or an unallocated `payments` row that later attaches to a charge.
-- The ledger won on two grounds. **Partial application**: 500 in, 200 applied now and 300 later is
-- three rows here and is inexpressible as one payment row, which has one amount and one charge.
-- **A receipt is not rewritten**: attaching an existing receipt to a later charge changes what a
-- printed, numbered, dated document refers to, which is the thing this schema consistently refuses
-- to do — it writes a revision or an adjustment instead.
--
-- The cost, recorded because it is real: money now lives in two tables and they have to reconcile.
-- `visit_charge_balances` is redefined below so they do.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

CREATE TYPE "CreditMovement" AS ENUM ('CREDIT', 'APPLIED', 'REFUNDED');

/*
 * One row per movement, never an updated balance.
 *
 * **Every amount is positive and the direction is the movement**, rather than signed amounts: a
 * negative money column invites a sum that silently nets two different events, and "never
 * forfeited" has to be provable by reading the table rather than by trusting arithmetic.
 *
 * `source_payment_id` is where credit came from — an unallocated payment, or the part of a payment
 * that exceeded what the patient owed. Both origins are payments, which is why it is required.
 */
CREATE TABLE "patient_credits" (
    "id"                UUID PRIMARY KEY,
    "tenant_id"         UUID NOT NULL REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "patient_id"        UUID NOT NULL REFERENCES "patients"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "movement"          "CreditMovement" NOT NULL,
    "amount_minor"      INTEGER NOT NULL,
    "reason"            TEXT,
    "actor_user_id"     UUID NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "source_payment_id" UUID REFERENCES "payments"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "applied_charge_id" UUID REFERENCES "visit_charges"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    -- Money is integer minor units and a movement of nothing is not a movement (CLAUDE.md, D7).
    CONSTRAINT "patient_credits_amount_positive" CHECK ("amount_minor" > 0),

    -- Each movement names its own counterpart, and never the other one's.
    CONSTRAINT "patient_credits_credit_has_source" CHECK (
        "movement" <> 'CREDIT' OR ("source_payment_id" IS NOT NULL AND "applied_charge_id" IS NULL)
    ),
    CONSTRAINT "patient_credits_applied_has_charge" CHECK (
        "movement" <> 'APPLIED' OR ("applied_charge_id" IS NOT NULL AND "source_payment_id" IS NULL)
    ),
    -- **A refund is refundable "on request with a reason"**, so the reason is not optional: a
    -- refund with no stated reason is the row somebody has to explain a year later.
    CONSTRAINT "patient_credits_refund_has_reason" CHECK (
        "movement" <> 'REFUNDED'
        OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0
            AND "source_payment_id" IS NULL AND "applied_charge_id" IS NULL)
    )
);

CREATE INDEX "patient_credits_tenant_id_patient_id_idx" ON "patient_credits" ("tenant_id", "patient_id");
CREATE INDEX "patient_credits_tenant_id_applied_charge_id_idx" ON "patient_credits" ("tenant_id", "applied_charge_id");
CREATE INDEX "patient_credits_tenant_id_source_payment_id_idx" ON "patient_credits" ("tenant_id", "source_payment_id");

-- RLS, the same shape as every other tenant-scoped table (D4, D15): ENABLE **and** FORCE, USING
-- **and** WITH CHECK. NULLIF turns an unbound session into NULL, so it fails closed with no rows.
ALTER TABLE "patient_credits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_credits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_credits"
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Append-only, like `payment_adjustments` and every other financial record (D5). "Never forfeited"
-- is only true if nothing can quietly remove a credit, and this is what makes that a fact.
CREATE OR REPLACE FUNCTION patient_credits_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'patient_credits is append-only: % refused on %', TG_OP, OLD.id
    USING HINT = 'Money is corrected by writing another movement, never by editing or deleting one.',
          ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patient_credits_append_only
  BEFORE UPDATE OR DELETE ON "patient_credits"
  FOR EACH ROW EXECUTE FUNCTION patient_credits_are_append_only();

-- Audited like every other tenant-scoped table.
CREATE TRIGGER patient_credits_audit
  AFTER INSERT OR UPDATE OR DELETE ON "patient_credits"
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

/*
 * **A patient's credit can never be spent below zero**, checked in the database rather than by the
 * caller that happens to be writing.
 *
 * Two receptionists applying the same credit to two charges at once is the case an application-level
 * read-then-write loses silently, and it loses by giving away money. The row is locked per patient
 * by summing under the same transaction; a negative result aborts it.
 */
CREATE OR REPLACE FUNCTION patient_credit_stays_solvent() RETURNS trigger AS $$
DECLARE
  balance INTEGER;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN movement = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)
    INTO balance
    FROM patient_credits
   WHERE tenant_id = NEW.tenant_id
     AND patient_id = NEW.patient_id;

  IF balance < 0 THEN
    RAISE EXCEPTION 'patient % would be left with a negative credit balance (%)', NEW.patient_id, balance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patient_credits_stay_solvent
  AFTER INSERT ON "patient_credits"
  FOR EACH ROW EXECUTE FUNCTION patient_credit_stays_solvent();

/*
 * The balance, as a view, for the reason ruling 3 gives for `visit_charge_balances`: a sum across
 * rows is not a GENERATED column. `security_invoker` is load-bearing — without it the view runs as
 * the migration superuser and returns every clinic's rows.
 */
CREATE VIEW patient_credit_balances WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.patient_id,
  COALESCE(SUM(CASE WHEN c.movement = 'CREDIT' THEN c.amount_minor ELSE 0 END), 0)::int  AS credited_minor,
  COALESCE(SUM(CASE WHEN c.movement = 'APPLIED' THEN c.amount_minor ELSE 0 END), 0)::int AS applied_minor,
  COALESCE(SUM(CASE WHEN c.movement = 'REFUNDED' THEN c.amount_minor ELSE 0 END), 0)::int AS refunded_minor,
  COALESCE(SUM(CASE WHEN c.movement = 'CREDIT' THEN c.amount_minor ELSE -c.amount_minor END), 0)::int
                                                                                          AS balance_minor
FROM patient_credits c
GROUP BY c.tenant_id, c.patient_id;

/*
 * **The two tables reconcile here.** A charge's paid amount is its receipts, minus the part of those
 * receipts that became credit rather than settling it, plus any credit later applied to it.
 *
 * Without the middle term an overpayment would drive the balance negative — which is exactly what
 * the old `PAYMENT_EXCEEDS_BALANCE` refusal existed to prevent, and what ruling 5 replaces by
 * turning the excess into credit instead of refusing the money.
 */
CREATE OR REPLACE VIEW visit_charge_balances WITH (security_invoker = true) AS
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
  (COALESCE(p.paid_minor, 0) - COALESCE(p.credited_minor, 0) + COALESCE(a.applied_minor, 0))::int
                      AS paid_minor,
  ((c.subtotal_minor - c.discount_minor - c.payer_share_minor)
     - (COALESCE(p.paid_minor, 0) - COALESCE(p.credited_minor, 0) + COALESCE(a.applied_minor, 0)))::int
                      AS balance_minor
FROM visit_charges c
LEFT JOIN (
  SELECT pay.visit_id,
         pay.tenant_id,
         SUM(pay.amount_minor)::int AS paid_minor,
         COALESCE(SUM(cr.credited)::int, 0) AS credited_minor
    FROM payments pay
    LEFT JOIN (
      SELECT source_payment_id, tenant_id, SUM(amount_minor)::int AS credited
        FROM patient_credits
       WHERE movement = 'CREDIT' AND source_payment_id IS NOT NULL
       GROUP BY source_payment_id, tenant_id
    ) cr ON cr.source_payment_id = pay.id AND cr.tenant_id = pay.tenant_id
   WHERE pay.visit_id IS NOT NULL
   GROUP BY pay.visit_id, pay.tenant_id
) p ON p.visit_id = c.visit_id AND p.tenant_id = c.tenant_id
LEFT JOIN (
  SELECT applied_charge_id, tenant_id, SUM(amount_minor)::int AS applied_minor
    FROM patient_credits
   WHERE movement = 'APPLIED' AND applied_charge_id IS NOT NULL
   GROUP BY applied_charge_id, tenant_id
) a ON a.applied_charge_id = c.id AND a.tenant_id = c.tenant_id;

SELECT set_config('app.current_actor_id', '', false);
