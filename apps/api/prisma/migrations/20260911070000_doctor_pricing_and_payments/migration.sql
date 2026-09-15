-- Phase 5 — doctor pricing and the payments screen. Founder's rulings R1 and R2, 2026-09-11.
--
-- ## R1 replaces the review queue rather than extending it
--
-- The queue is removed: no screen, no `needs_review`. Admin oversight is now the adjustment lines
-- themselves, visible in the payments view (R2), which is a record of what happened rather than a
-- list of things waiting for someone.
--
-- **A doctor who is allowed to move a price does it as a signed adjustment line, never by editing
-- the snapshotted ones.** A snapshot that can be edited is not a snapshot: the whole reason charge
-- lines freeze their name and price is that a completed invoice must not change underneath anyone.
-- An adjustment is a second line saying who moved the total, by how much, and why — arithmetic
-- anyone can follow rather than a figure that silently differs from what was recorded.
--
-- ## R2 needs one new capability and one changed one
--
-- `payments.read` is new. `payments.record` loses ADMIN, because the ruling is that an admin may
-- see the money and not take it — which is a separation of duties rather than a convenience.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

-- ---------------------------------------------------------------------------------------------
-- R1: the review queue goes.

ALTER TABLE "visit_charge_lines" DROP COLUMN IF EXISTS "needs_review";
DROP INDEX IF EXISTS "visit_charge_lines_needs_review_idx";

-- A signed adjustment is a line like any other, distinguished by its source.
ALTER TYPE "ChargeLineSource" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';

-- ---------------------------------------------------------------------------------------------
-- R1: the two per-doctor settings, and R2's third.

-- "يُسمح له بتعديل الأسعار" — set by an admin on the doctor form. Default false: a permission that
-- arrives switched on is a permission nobody decided to grant.
ALTER TABLE "doctors" ADD COLUMN "may_adjust_prices" BOOLEAN NOT NULL DEFAULT false;
-- "يحصّل المدفوعات بنفسه" — R2. Same default, same reason.
ALTER TABLE "doctors" ADD COLUMN "collects_payments" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- R1: where the adjustment lives before the charge exists.
--
-- The doctor adjusts the total **before** completing the visit, and the charge is written **by**
-- completion — so there is no charge to hang a line on yet. The adjustment is recorded against the
-- visit and copied into `visit_charge_lines` when the charge is created, which keeps one rule
-- ("never edit a snapshotted line") true at every point rather than only at the end.

ALTER TABLE "visits" ADD COLUMN "price_adjustment_minor" INTEGER;
ALTER TABLE "visits" ADD COLUMN "price_adjustment_reason" TEXT;
ALTER TABLE "visits" ADD COLUMN "price_adjusted_by_user_id" UUID;
ALTER TABLE "visits" ADD COLUMN "price_adjusted_at" TIMESTAMPTZ(6);

ALTER TABLE "visits"
    ADD CONSTRAINT "visits_price_adjusted_by_fkey"
    FOREIGN KEY ("price_adjusted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An adjustment is an amount, a person and an instant together, or none of them. Half of one is a
-- row nobody can account for, and this is money.
ALTER TABLE "visits"
    ADD CONSTRAINT "visits_price_adjustment_is_whole"
    CHECK (
      ("price_adjustment_minor" IS NULL AND "price_adjusted_by_user_id" IS NULL AND "price_adjusted_at" IS NULL)
      OR ("price_adjustment_minor" IS NOT NULL AND "price_adjusted_by_user_id" IS NOT NULL AND "price_adjusted_at" IS NOT NULL)
    );

-- Zero is not an adjustment. Clearing one removes it; recording one moves the total.
ALTER TABLE "visits"
    ADD CONSTRAINT "visits_price_adjustment_not_zero"
    CHECK ("price_adjustment_minor" IS NULL OR "price_adjustment_minor" <> 0);

-- The reason is optional (the ruling says so), but it cannot exist without the adjustment.
ALTER TABLE "visits"
    ADD CONSTRAINT "visits_price_adjustment_reason_needs_adjustment"
    CHECK ("price_adjustment_reason" IS NULL OR "price_adjustment_minor" IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- The charge line that carries it.

-- **A negative line is legal only for an adjustment.** The existing constraint refuses one on any
-- line, which is right for a procedure -- a negative price there is a refund wearing a charge's
-- clothes -- and wrong for the thing R1 introduces. Compared as text rather than as the enum:
-- Postgres refuses to use an enum value added earlier in the same transaction.
ALTER TABLE "visit_charge_lines" DROP CONSTRAINT "visit_charge_lines_price_not_negative";
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_price_not_negative"
    CHECK ("source"::text = 'ADJUSTMENT' OR "unit_price_minor" >= 0);

ALTER TABLE "visit_charge_lines" ADD COLUMN "adjusted_by_user_id" UUID;
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_adjusted_by_fkey"
    FOREIGN KEY ("adjusted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The discriminator gains its fourth branch. An ADJUSTMENT points at no catalogue row and names
-- the doctor; every other kind of line names nobody, so the column cannot drift onto one.
ALTER TABLE "visit_charge_lines" DROP CONSTRAINT "visit_charge_lines_source_matches_origin";
ALTER TABLE "visit_charge_lines"
    ADD CONSTRAINT "visit_charge_lines_source_matches_origin"
    CHECK (
      ("source"::text = 'CATALOGUE' AND "service_id" IS NOT NULL AND "material_id" IS NULL AND "adjusted_by_user_id" IS NULL)
      OR ("source"::text = 'MATERIAL' AND "material_id" IS NOT NULL AND "service_id" IS NULL AND "adjusted_by_user_id" IS NULL)
      OR ("source"::text = 'AD_HOC' AND "service_id" IS NULL AND "material_id" IS NULL AND "adjusted_by_user_id" IS NULL)
      OR ("source"::text = 'ADJUSTMENT' AND "service_id" IS NULL AND "material_id" IS NULL AND "adjusted_by_user_id" IS NOT NULL)
    );

SELECT set_config('app.current_actor_id', '', false);
