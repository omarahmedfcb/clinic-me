-- Phase 5, PR 6 — the discount ceiling. `PHASE-5-PLAN.md` PR 6, ruling 4.
--
-- ## "10% or 50 EGP, whichever is lower" is two settings and a LEAST, not one number
--
-- The founder read this back and ruled it in: the ceiling is **both**, taking the lower. Two
-- nullable columns, and the effective ceiling for a charge is the lower of those that are set. That
-- is a better rule than either alone — the percentage keeps the ceiling proportionate on a large
-- invoice, and the flat amount stops a percentage of a very large invoice becoming a discount
-- nobody meant to authorise.
--
-- ## 50 EGP cannot be stored as EGP
--
-- `CLAUDE.md` forbids a column named or formatted as a currency; currency lives in
-- `tenants.currency`. So the **default** is 5000 minor units, applied at tenant creation in that
-- tenant's own currency — correct for an Egyptian clinic and meaningless for any other, which is
-- why it is a default on the column rather than a constant the check reads. The moment a non-EGP
-- tenant exists, that default is wrong rather than merely unconverted, and it is a value someone
-- can change instead of a number buried in a constraint.
--
-- ## Why the ceiling is a CHECK and not a DTO rule
--
-- Ruled explicitly, and it is the distinction this project keeps relearning: a service-layer check
-- passes on a machine where the migration was never applied, and never sees the seed, direct SQL or
-- a future bulk import. `visit_charges` already refuses a discount larger than the subtotal and a
-- discount with no reason; this adds the ceiling to the same layer.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "tenants" ADD COLUMN "discount_ceiling_percent" INTEGER DEFAULT 10;
-- 5000 minor units, in the tenant's own currency. See the note above about EGP.
ALTER TABLE "tenants" ADD COLUMN "discount_ceiling_minor" INTEGER DEFAULT 5000;

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_discount_ceiling_percent_range"
    CHECK ("discount_ceiling_percent" IS NULL
        OR ("discount_ceiling_percent" >= 0 AND "discount_ceiling_percent" <= 100));
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_discount_ceiling_minor_not_negative"
    CHECK ("discount_ceiling_minor" IS NULL OR "discount_ceiling_minor" >= 0);

-- Who authorised a discount above the ceiling. NULL means nobody had to: the discount is within
-- what reception may give. Recording the person rather than a boolean, because "who allowed this"
-- is the question anyone looking at a discounted invoice actually asks.
ALTER TABLE "visit_charges" ADD COLUMN "discount_authorised_by_user_id" UUID;
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_discount_authorised_by_fkey"
    FOREIGN KEY ("discount_authorised_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- The ceiling itself.
--
-- A CHECK cannot reach another table, so the tenant's two settings are copied onto the charge when
-- it is written and the constraint compares columns on one row. That is a snapshot, and it is the
-- right shape for the same reason every other money snapshot here is: raising the clinic's ceiling
-- next year must not retroactively authorise a discount nobody approved.

ALTER TABLE "visit_charges" ADD COLUMN "ceiling_percent_snapshot" INTEGER;
ALTER TABLE "visit_charges" ADD COLUMN "ceiling_minor_snapshot" INTEGER;

CREATE OR REPLACE FUNCTION snapshot_discount_ceiling() RETURNS TRIGGER AS $$
DECLARE
  percent_setting INTEGER;
  minor_setting INTEGER;
BEGIN
  IF NEW.ceiling_percent_snapshot IS NULL AND NEW.ceiling_minor_snapshot IS NULL THEN
    SELECT discount_ceiling_percent, discount_ceiling_minor
      INTO percent_setting, minor_setting
      FROM tenants WHERE id = NEW.tenant_id;
    NEW.ceiling_percent_snapshot := percent_setting;
    NEW.ceiling_minor_snapshot := minor_setting;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visit_charges_snapshot_ceiling
  BEFORE INSERT ON visit_charges
  FOR EACH ROW EXECUTE FUNCTION snapshot_discount_ceiling();

-- **Existing charges keep NULL ceilings, deliberately.** Backfilling today's ceiling onto them
-- would judge history by a rule that did not exist when they were written -- and it fails on the
-- first attempt, because the seeded data carries discounts of up to 30%. NULL on both snapshots
-- reads as "no ceiling applied at the time", which is exactly true, and the constraint below
-- exempts it. New charges get the snapshot from the trigger.

-- **The ceiling, as a constraint.** A discount is legal when it is within the lower of whichever
-- ceilings are set, OR when somebody with the authority to exceed them said so and is named.
-- `LEAST` ignores NULLs, so a clinic that sets only one of the two gets exactly that one.
ALTER TABLE "visit_charges"
    ADD CONSTRAINT "visit_charges_discount_within_ceiling"
    CHECK (
      "discount_minor" = 0
      OR "discount_authorised_by_user_id" IS NOT NULL
      OR "discount_minor" <= LEAST(
           CASE WHEN "ceiling_percent_snapshot" IS NULL THEN NULL
                ELSE ("subtotal_minor" * "ceiling_percent_snapshot") / 100 END,
           "ceiling_minor_snapshot"
         )
      OR ("ceiling_percent_snapshot" IS NULL AND "ceiling_minor_snapshot" IS NULL)
    );

SELECT set_config('app.current_actor_id', '', false);
