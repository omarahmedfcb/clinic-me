-- R1 as amended, 2026-09-11: a doctor's pricing permission gains an optional cap.
--
-- Percent, flat amount, or both; empty means unlimited, which is what every doctor allowed to
-- adjust prices has had until now. Two columns and a LEAST rather than one number, for the reason
-- the discount ceiling records: "10% or 500 EGP, whichever is lower" is two settings, and a clinic
-- that sets only one half is bound by that one.
--
-- **The cap is enforced in the database as well as at the route.** The route returns a sentence
-- with the limit in it, which a constraint cannot; the trigger is what makes the rule true for the
-- seed, for direct SQL, and for whatever writes this table next. A CHECK cannot express it — the
-- cap lives on `doctors` and the base is a sum over `visit_procedures`, so it is a trigger.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "doctors" ADD COLUMN "price_adjustment_cap_percent" INTEGER;
ALTER TABLE "doctors" ADD COLUMN "price_adjustment_cap_minor" INTEGER;

-- A cap of zero is not a cap, it is a withdrawn permission — `may_adjust_prices` says that already.
ALTER TABLE "doctors"
    ADD CONSTRAINT "doctors_price_cap_percent_sane"
    CHECK ("price_adjustment_cap_percent" IS NULL
           OR ("price_adjustment_cap_percent" > 0 AND "price_adjustment_cap_percent" <= 100));
ALTER TABLE "doctors"
    ADD CONSTRAINT "doctors_price_cap_minor_positive"
    CHECK ("price_adjustment_cap_minor" IS NULL OR "price_adjustment_cap_minor" > 0);

/*
 * The cap applies to the **size** of the move, in either direction.
 *
 * A doctor allowed to vary a bill by 10% may reduce it by that much or add that much; "up to 10%"
 * describes a distance from the total, not a direction. The base is the visit's procedures priced
 * the way completion prices them — the procedure's own price when it has one, the catalogue's
 * otherwise — so the percentage means what a reader of the doctor form would assume it means.
 */
CREATE OR REPLACE FUNCTION enforce_price_adjustment_cap() RETURNS trigger AS $$
DECLARE
  cap_percent INTEGER;
  cap_minor   INTEGER;
  base        INTEGER;
  cap         INTEGER;
BEGIN
  IF NEW.price_adjustment_minor IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.price_adjustment_cap_percent, d.price_adjustment_cap_minor
    INTO cap_percent, cap_minor
    FROM doctors d
   WHERE d.id = NEW.doctor_id;

  -- Neither set is the ordinary case and means unlimited, as the doctor form says.
  IF cap_percent IS NULL AND cap_minor IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(COALESCE(vp.unit_price_minor, s.price_minor, 0) * vp.quantity), 0)
    INTO base
    FROM visit_procedures vp
    LEFT JOIN services s ON s.id = vp.service_id
   WHERE vp.visit_id = NEW.id;

  -- LEAST ignores NULLs, so a clinic that sets only one half is bound by that one.
  cap := LEAST(
    CASE WHEN cap_percent IS NULL THEN NULL ELSE (base * cap_percent) / 100 END,
    cap_minor
  );

  IF ABS(NEW.price_adjustment_minor) > cap THEN
    RAISE EXCEPTION
      'price adjustment % exceeds this doctor''s cap of % on a base of %',
      NEW.price_adjustment_minor, cap, base
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visits_price_adjustment_cap
  BEFORE INSERT OR UPDATE OF price_adjustment_minor ON "visits"
  FOR EACH ROW EXECUTE FUNCTION enforce_price_adjustment_cap();

SELECT set_config('app.current_actor_id', '', false);
