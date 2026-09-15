-- Phase 4, PR 7f — clinic identity and the doctor's print fields. `PHASE-4.md` Q28.
--
-- Pulled forward from Phase 5 because printing needs them (Q9, Q29). Images are storage KEYS, never
-- URLs: `StorageProvider` has no `url()` by design, so a column named `_url` would invite a caller
-- to hand a doctor's signature to a browser and make the capability gate decoration.

ALTER TABLE "tenants" ADD COLUMN "logo_storage_key" TEXT;
ALTER TABLE "tenants" ADD COLUMN "secondary_phone" TEXT;

-- `signature_url` has existed since Phase 1 and nothing has ever written or read it. Renamed rather
-- than left beside its replacement, so there is one column and it is named after what it holds.
ALTER TABLE "doctors" RENAME COLUMN "signature_url" TO "signature_storage_key";

ALTER TABLE "doctors" ADD COLUMN "stamp_storage_key" TEXT;
-- The name as it should appear on a prescription, when that differs from the login name.
ALTER TABLE "doctors" ADD COLUMN "printed_name" TEXT;
ALTER TABLE "doctors" ADD COLUMN "syndicate_number" TEXT;
