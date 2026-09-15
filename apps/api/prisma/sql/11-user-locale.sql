-- Phase 1 addendum — SCHEMA-DECISIONS.md D20 (interface language and document language are
-- different settings).
--
-- Adds the per-user interface-language override D20 specifies, and constrains the value domain on
-- both columns that hold a locale.
--
--
-- WHY THE OVERRIDE IS ON users, NOT ON memberships
--
-- D20 is explicit: a doctor holding memberships in two clinics wants one language, not one per
-- clinic. Putting it on memberships would make "my interface is in English" a per-employer fact,
-- which is not how anyone experiences their own reading language.
--
--
-- WHY IT IS NULLABLE, AND WHY THAT IS NOT THE SAME AS DEFAULTING TO ARABIC
--
-- NULL means "no override — follow the tenant". It is deliberately distinguishable from an
-- explicit 'ar', and a DEFAULT would destroy that distinction: every user who had never opened the
-- setting would look like they had chosen Arabic, and a clinic switching its default to English
-- would find that it changed nothing for anybody. The resolution chain in D20 depends on being
-- able to tell "unset" from "set to the same value the tenant happens to use".
--
-- This is the same reasoning as D6's rejection of a database default for id: a value that arrives
-- because nobody chose it must not be indistinguishable from one that was chosen.
--
--
-- WHY A CHECK AND NOT A POSTGRES ENUM
--
-- The value domain is small and closed today ('ar', 'en') but is the kind that grows — a Cairo
-- clinic serving French-speaking patients is not far-fetched. Extending a CHECK is an ALTER;
-- extending a Prisma enum regenerates the client and touches every consumer of the type. The
-- trade-off is that application code sees `string` rather than a union type, which is a real loss
-- and is flagged in D20 as a decision to revisit if a third locale never appears.
--
-- tenants.locale has been an unconstrained TEXT since the initial migration, which means 'AR',
-- 'arabic' or '' have all been storable and would fall through the resolution chain to whatever
-- the frontend does with an unrecognised value. Constraining it here is additive — no type change,
-- no client regeneration — and leaving the two columns holding the same domain under different
-- rules would be its own inconsistency.

ALTER TABLE users ADD COLUMN locale TEXT;

COMMENT ON COLUMN users.locale IS
  'Interface language override (SCHEMA-DECISIONS.md D20). NULL means no override — follow the '
  'tenant default. Not the document language, which is tenant-level and separate.';


-- ---------------------------------------------------------------------------------------------
-- Normalise BEFORE constraining. This migration originally added the CHECK straight away, which
-- made it un-runnable against any database seeded by an earlier version of this application:
-- tenants.locale held 'ar-EG', a BCP-47 tag, because the column predates D20 and was read as an
-- Intl locale. `prisma migrate deploy` then failed with
--
--   check constraint "tenants_locale_supported" of relation "tenants" is violated by some row
--
-- and the environment could not move forward at all. A fresh database has no rows, so CI and every
-- test database passed -- the failure only appears where there is data, which is every environment
-- that matters.
--
-- ARCHITECTURE.md §14 requires migrations to be backward-compatible for one release. A constraint
-- that rejects data the previous release legitimately wrote is not.
--
-- The region belongs in the frontend's Intl mapping (apps/web/src/i18n/format.ts), not in a stored
-- preference. A value whose language subtag is neither 'ar' nor 'en' is left alone, so the CHECK
-- below then fails loudly on it -- that is data nobody has decided about, and guessing would be
-- worse than stopping.
UPDATE tenants SET locale = split_part(locale, '-', 1) WHERE locale NOT IN ('ar', 'en');
UPDATE users   SET locale = split_part(locale, '-', 1) WHERE locale IS NOT NULL AND locale NOT IN ('ar', 'en');

ALTER TABLE users
  ADD CONSTRAINT users_locale_supported CHECK (locale IS NULL OR locale IN ('ar', 'en'));

-- tenants.locale is NOT NULL: a tenant always has a default, and NULL there would leave the
-- resolution chain with nothing to fall back to but the hardcoded Arabic.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_locale_supported CHECK (locale IN ('ar', 'en'));
