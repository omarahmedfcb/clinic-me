-- Phase 4, PR 7l — printed documents are English, and a visit can carry sick leave.
-- `PHASE-4.md` Q45 and Q46.
--
-- ## The English columns are nullable, and the sheet falls back rather than refusing
--
-- A clinic that has not filled its English name still prints. The sheet uses the Arabic value in
-- that case, which is worse than an English letterhead and far better than a blank one — the
-- alternative is a document that cannot be produced because a settings box is empty.
--
-- ## Sick leave lives on the visit, not in its own table
--
-- One visit issues at most one sick-leave certificate, and every field is about that visit: the
-- days, the date it starts, and a note. A separate table would buy a history of certificates per
-- visit, which is not a thing an Egyptian outpatient clinic issues, and would cost a join on every
-- print. `sick_leave_printed_count` mirrors `prescriptions.printed_count` so both answer the same
-- question the same way (Q9: the count is of sheets produced, not of dialogs dismissed).

ALTER TABLE "tenants" ADD COLUMN "name_en" TEXT;
ALTER TABLE "tenants" ADD COLUMN "address_en" TEXT;

ALTER TABLE "doctors" ADD COLUMN "printed_name_en" TEXT;

-- The prescription line, as an Egyptian prescription is actually written. `dose` and `frequency`
-- already existed and stay: they are what goes in "dosage & instructions" on the printed table,
-- while strength ("500 mg") and form ("F.C. tablet") identify the product and quantity is what the
-- pharmacist dispenses.
ALTER TABLE "prescription_items" ADD COLUMN "strength" TEXT;
ALTER TABLE "prescription_items" ADD COLUMN "form" TEXT;
ALTER TABLE "prescription_items" ADD COLUMN "quantity" TEXT;

ALTER TABLE "visits" ADD COLUMN "sick_leave_days" INTEGER;
ALTER TABLE "visits" ADD COLUMN "sick_leave_from" DATE;
ALTER TABLE "visits" ADD COLUMN "sick_leave_note" TEXT;
ALTER TABLE "visits" ADD COLUMN "sick_leave_printed_count" INTEGER NOT NULL DEFAULT 0;

-- Days are a positive count or nothing at all. A zero-day certificate is not a document anyone
-- issues, and a negative one is a data-entry slip that would print as "-3 days" on a clinic's
-- letterhead. Enforced here rather than only in the DTO, because the database is the layer that
-- cannot be bypassed (CLAUDE.md: push an invariant to the hardest layer that can reject it).
ALTER TABLE "visits"
  ADD CONSTRAINT "visits_sick_leave_days_positive"
  CHECK ("sick_leave_days" IS NULL OR "sick_leave_days" > 0);

-- The two halves arrive together or not at all: a certificate with a start and no duration, or a
-- duration and no start, cannot be printed and would sit in the record looking like a decision.
ALTER TABLE "visits"
  ADD CONSTRAINT "visits_sick_leave_is_whole"
  CHECK (("sick_leave_days" IS NULL) = ("sick_leave_from" IS NULL));

-- A note about a certificate that does not exist is a note about nothing.
ALTER TABLE "visits"
  ADD CONSTRAINT "visits_sick_leave_note_needs_leave"
  CHECK ("sick_leave_note" IS NULL OR "sick_leave_days" IS NOT NULL);
