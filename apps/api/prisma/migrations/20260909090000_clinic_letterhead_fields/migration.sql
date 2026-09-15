-- Phase 4, PR 7i — the rest of what an Egyptian clinic prints on its letterhead. `PHASE-4.md` Q37.
--
-- All nullable and all free text. A clinic that has no commercial register, or bills no tax, must be
-- able to say so by leaving the box empty; the sheet prints what is filled and omits what is not.
-- Working hours are deliberately text and not a schedule: what a letterhead carries is
-- "السبت–الخميس ٩ص–٩م", which no set of columns reproduces without inventing a second calendar.

ALTER TABLE "tenants" ADD COLUMN "tax_registration_number" TEXT;
ALTER TABLE "tenants" ADD COLUMN "commercial_register_number" TEXT;
ALTER TABLE "tenants" ADD COLUMN "email" TEXT;
ALTER TABLE "tenants" ADD COLUMN "whatsapp_phone" TEXT;
ALTER TABLE "tenants" ADD COLUMN "printed_working_hours" TEXT;
ALTER TABLE "tenants" ADD COLUMN "tagline" TEXT;
