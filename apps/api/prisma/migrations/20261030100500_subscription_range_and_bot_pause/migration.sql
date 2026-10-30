-- The subscription becomes a range: a start day beside the existing end day (`renewal_on`, the last
-- working day), and the bot goes silent outside it. Safe to run twice.
--
--   1. platform_clinic_files.subscription_starts_on  the first working day. Nullable: a clinic with no
--      range has no bot. Rows that already have an end day are given a start by the outbound worker's
--      next pass (their creation day), so this migration needs no UPDATE under row-level security.
--   2. platform_clinic_files.account_status default  ACTIVE instead of TRIAL. The old default made the
--      first save of any client file fail platform_clinic_files_trial_is_dated, because a TRIAL needs a
--      trial_ends_on and a fresh file has none.
--   3. tenants.bot_paused  true while the clinic has no range or its range has not started. Staff sign-in
--      is untouched; the WhatsApp webhook, the outbound messages and the web chat check it.

ALTER TABLE "platform_clinic_files" ADD COLUMN IF NOT EXISTS "subscription_starts_on" DATE;

ALTER TABLE "platform_clinic_files" DROP CONSTRAINT IF EXISTS "platform_clinic_files_range_ordered";
ALTER TABLE "platform_clinic_files" ADD CONSTRAINT "platform_clinic_files_range_ordered"
  CHECK ("subscription_starts_on" IS NULL OR "renewal_on" IS NULL OR "subscription_starts_on" <= "renewal_on");

ALTER TABLE "platform_clinic_files" ALTER COLUMN "account_status" SET DEFAULT 'ACTIVE';

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "bot_paused" BOOLEAN NOT NULL DEFAULT false;
