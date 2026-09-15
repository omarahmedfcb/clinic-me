-- Phase 4 — the quoted price snapshot. `PHASE-4.md` §5, `PHASE-5-DESIGN.md` §2.2.
--
-- One nullable integer column, and the reasoning is the whole of it.
--
--
-- WHY THE COLUMN EXISTS AT ALL
--
-- `appointments` stores `service_id` and no price, so the only record of what an appointment costs
-- is a live join to `services.price_minor` -- a mutable row. That has been harmless for exactly one
-- reason: nothing has ever edited a service price, because services arrive from the seed.
--
-- Clinic-managed services is the feature that starts editing them. On the day it ships, without
-- this column, every past appointment's price silently becomes whatever the service costs today.
-- Not wrong-and-detectable: wrong-and-unrecoverable, because the previous value was never written
-- anywhere. The column is in the same phase as the screen for that reason and no other.
--
--
-- WHAT IT MEANS, WHICH IS NOT "THE PRICE"
--
-- `quoted_price_minor` is what reception told the patient at booking. It is deliberately NOT the
-- amount the clinic ends up charging: from Phase 5 that is the set of charge lines recorded when
-- the visit completes, and the two are allowed to differ. The difference is the conversation that
-- happens at the desk -- "you told me three hundred" -- and a clinic that stores only the charge has
-- no record of its own promise.
--
--
-- WHY NULLABLE, WHICH LOOKS LIKE THE WEAKER CHOICE
--
-- Every appointment booked from here on writes it. It cannot be NOT NULL without backfilling the
-- rows that already exist, and the only value available to backfill them with is *today's*
-- `services.price_minor` -- which is precisely the falsification this column was added to prevent.
-- A backfilled row would assert "reception quoted this patient 300" about a conversation that
-- either never happened or happened at a different number, and nothing downstream could tell it
-- apart from a row that recorded a real quote.
--
-- So NULL means "no quote was recorded", which is the truth about every appointment booked before
-- this column existed, and a screen must render it as "not recorded" -- never as zero, and never as
-- the service's current price.
--
--
-- NO BACKFILL. This migration deliberately does not write a single existing row.

ALTER TABLE appointments ADD COLUMN quoted_price_minor INT;

-- Integer minor units (CLAUDE.md), never a float, and no currency column: currency lives on
-- `tenants`, so an appointment cannot be quoted in a currency the clinic does not price in.
--
-- The CHECK is here rather than only in the DTO because a DTO is a convention and a constraint is
-- not. A negative quote is not a state any code path should be able to reach, and the database is
-- the layer that can say so regardless of which code path tries.
ALTER TABLE appointments ADD CONSTRAINT appointments_quoted_price_minor_non_negative
  CHECK (quoted_price_minor IS NULL OR quoted_price_minor >= 0);

COMMENT ON COLUMN appointments.quoted_price_minor IS
  'What reception told the patient at booking, in minor units. Snapshotted from services.price_minor '
  'so that editing a service price cannot rewrite history. NULL means no quote was recorded -- true '
  'of every appointment booked before this column existed -- and must render as "not recorded", '
  'never as zero. Not the amount charged: that is the visit charge lines, from Phase 5.';
