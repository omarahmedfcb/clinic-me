-- Phase 1 addendum — SCHEMA-DECISIONS.md D20.
--
-- Promotes the locale value domain from a CHECK-constrained TEXT to a Postgres enum, and keeps the
-- CHECK. Both layers, deliberately.
--
--
-- WHY AN ENUM WHEN A CHECK ALREADY EXISTED
--
-- The CHECK is a database guarantee and gives application code nothing: Prisma maps a constrained
-- TEXT to `string`, so every consumer handles a value that could be anything and needs a runtime
-- guard to compensate. With an enum, `locale` is `"ar" | "en"` at every call site and a wrong value
-- is a compile error.
--
-- The argument against was that extending an enum regenerates the client while extending a CHECK is
-- an ALTER. That is the right trade for a set that grows often; this one does not. A third interface
-- language is a market decision with weeks of translation behind it, not a quick add, and paying the
-- regeneration cost once is trivial against handling `string` everywhere forever.
--
-- Taking compile-time safety off a new column one day after building it into every write path
-- (injected(), SCHEMA-DECISIONS.md D6/D7) would also just be inconsistent.
--
--
-- WHY THE CHECK STAYS
--
-- It is not redundant, and that is worth spelling out because it looks it. `ALTER TYPE ... ADD
-- VALUE` extends a Postgres enum without touching a CHECK, so after this migration the CHECK is the
-- NARROWER guard: adding 'fr' to the type does not make 'fr' storable until someone also widens the
-- CHECK. That makes extending the locale set a two-step, deliberate act rather than a one-line
-- ALTER somebody runs while debugging. Same defence-in-depth as tenant scoping — a compile-time
-- guarantee, a database guarantee, and neither trusted to be the only one.
--
--
-- THE DATA MIGRATION, AND THE BUG IT REPAIRS
--
-- tenants.locale held 'ar-EG' — a BCP-47 tag — because it predates D20 and was being read as an
-- Intl locale. D20 redefines the column as the interface language, 'ar' | 'en', and the region
-- belongs in the frontend's Intl mapping instead (apps/web/src/i18n/format.ts).
--
-- Migration 11 added a CHECK for the new domain without migrating the old values, which broke
-- `npm run seed` — the seed writes 'ar-EG' and Postgres refused it with 23514. Nothing caught that
-- because CI has never run the seed; it does now. The UPDATE below repairs any row still holding a
-- regional tag. A value whose language subtag is not 'ar' or 'en' is left alone and the cast then
-- fails loudly, which is the correct outcome: that is data nobody has decided about.

CREATE TYPE locale_code AS ENUM ('ar', 'en');

ALTER TABLE users DROP CONSTRAINT users_locale_supported;
ALTER TABLE tenants DROP CONSTRAINT tenants_locale_supported;

-- 'ar-EG' -> 'ar'. Narrow on purpose: only rows that would otherwise fail the cast are touched.
UPDATE tenants SET locale = split_part(locale, '-', 1) WHERE locale NOT IN ('ar', 'en');
UPDATE users   SET locale = split_part(locale, '-', 1) WHERE locale IS NOT NULL AND locale NOT IN ('ar', 'en');

ALTER TABLE tenants ALTER COLUMN locale TYPE locale_code USING locale::locale_code;
ALTER TABLE users   ALTER COLUMN locale TYPE locale_code USING locale::locale_code;

ALTER TABLE users
  ADD CONSTRAINT users_locale_supported CHECK (locale IS NULL OR locale IN ('ar', 'en'));

ALTER TABLE tenants
  ADD CONSTRAINT tenants_locale_supported CHECK (locale IN ('ar', 'en'));

COMMENT ON TYPE locale_code IS
  'Interface language (SCHEMA-DECISIONS.md D20). Not a BCP-47 tag: the region belongs in the '
  'frontend Intl mapping, not in the stored preference. Extending this type also requires widening '
  'the users_locale_supported and tenants_locale_supported CHECK constraints.';
