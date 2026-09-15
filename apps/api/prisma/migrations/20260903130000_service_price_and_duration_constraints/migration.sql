-- Two CHECK constraints on `services` that the code already believed were there.
--
--
-- WHAT WAS ACTUALLY TRUE, CHECKED RATHER THAN ASSUMED
--
-- `services.dto.ts` carries this comment above its bounds:
--
--   "The bounds on `durationMinutes` and `bufferMinutes` mirror the database CHECKs rather than
--    replacing them -- a 400 here is a better error than a 23514 from Postgres, but the constraint
--    is what actually guarantees it."
--
-- Read against pg_constraint on 2026-09-03, that was half true. The table had exactly one CHECK:
--
--   services_buffer_minutes_sane   CHECK (buffer_minutes >= 0 AND buffer_minutes <= 240)
--
-- `duration_minutes` had none, and `price_minor` had none. So for two of the three fields the only
-- thing standing between a bad value and the row was a DTO -- while a comment in that same DTO
-- asserted the database was the guarantee. That is worse than an undocumented gap: it is a gap
-- with a note next to it saying there is no gap.
--
--
-- WHY THESE ARE CONSTRAINTS AND NOT VALIDATION
--
-- The founder's standing rule, applied here in his words: "a DTO rule is a convention, and we've
-- ruled repeatedly that a convention isn't a guardrail." A DTO guards one door. The seed does not
-- go through it, `prisma db execute` does not, a future admin-console bulk import would not, and
-- neither would any AI tool call that reached the service layer directly.
--
-- A negative price is the one that matters most, because it is silent. It does not throw, it does
-- not look wrong on a screen, and from Phase 5 it flows into a charge line and a patient balance
-- as a credit nobody authorised.
--
--
-- BOUNDS MATCH THE DTO EXACTLY, ON PURPOSE
--
-- 1..480 minutes for duration, mirroring @Min(1) @Max(480), so the DTO's 400 stays the message a
-- caller sees in the ordinary case and the constraint is the backstop rather than a second,
-- stricter opinion. `price_minor` gets a floor and no ceiling: there is no defensible maximum for
-- what a clinic may charge, and inventing one would be a support ticket the first time a clinic
-- prices a surgical procedure.
--
-- Verified before writing: zero existing rows violate either constraint (7 services, prices
-- 12000..90000, durations 15..45).

ALTER TABLE services ADD CONSTRAINT services_price_minor_non_negative
  CHECK (price_minor >= 0);

ALTER TABLE services ADD CONSTRAINT services_duration_minutes_sane
  CHECK (duration_minutes >= 1 AND duration_minutes <= 480);

COMMENT ON CONSTRAINT services_price_minor_non_negative ON services IS
  'Integer minor units, never negative. The DTO also refuses one; this is the layer that refuses '
  'it for the seed, for direct SQL, and for any caller that never passes through a DTO.';
