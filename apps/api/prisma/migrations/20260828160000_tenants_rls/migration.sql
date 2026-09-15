-- Phase 2 — SCHEMA-DECISIONS.md D22.
--
-- RLS on `tenants`, which D15 deliberately left out. D15's reason was "Tenant IS a tenant", and
-- that is true of why the table has no `tenant_id` column -- but it silently also answered a
-- question it was not asked. Having no `tenant_id` explains why the *scoping extension* cannot
-- filter this table. It does not explain why a session already bound to tenant A may read tenant
-- B's row, and until now nothing stopped it.
--
--
-- WHAT THIS FIXES, CONCRETELY
--
-- `tenant.findMany()` inside `withTenant()` returned 173 rows in the test database: every clinic
-- in it. That call looked correctly scoped -- it sat inside the sanctioned wrapper, which is the
-- one construct in this codebase that is supposed to make scoping automatic. Every other table
-- reached through `withTenant()` is genuinely safe there. This one was not, and no comment,
-- type, or test said so.
--
-- The near-miss was not the read itself but what would have been done with it: the appointments
-- service takes `slot_granularity_minutes`, the two booking lead times and `no_show_grace_minutes`
-- from this row. Taking `[0]` from an unfiltered list would have applied a stranger's scheduling
-- policy to a clinic, producing numbers that still look like numbers -- no assertion about slot
-- counts would ever have caught it.
--
--
-- THE POLICY IS INVERTED RELATIVE TO EVERY OTHER ONE IN THIS SCHEMA. READ THIS PART.
--
-- Every other policy fails CLOSED when `app.current_tenant_id` is unset: `tenant_id = NULL` is
-- never true, so an unbound session sees nothing. That is right for those tables, because no
-- legitimate operation on them is unbound.
--
-- This table has three that are, and all three are structural rather than sloppy:
--
--   1. CREATING a tenant. There is no tenant to bind before the row exists. No session variable
--      can solve that ordering; it is the same shape of problem D15 hit with membership lookup.
--   2. `prisma/backfill/name-search-latin.ts`, which walks every tenant by design.
--   3. `prisma/seed/index.ts`, which lists existing clinics to decide whether to re-seed, and
--      `seed-staff.ts`, which creates them.
--
-- So the predicate permits an unbound session and constrains a bound one. That is weaker than
-- fail-closed and the weakness is stated rather than hidden: a code path that forgets to bind a
-- tenant still sees every row here. Two things make that an acceptable trade rather than a hole
-- being waved through.
--
-- First, it closes the case that actually bit us and the only one an authenticated request can
-- reach -- every request-serving path in this application runs inside `withTenant()`, so for
-- them the variable is always bound.
--
-- Second, the login path is unaffected either way, which is worth recording because it was the
-- obvious suspected blocker and turns out not to be one. `list_active_memberships_for_user()` and
-- `resolve_active_membership()` (04-membership-lookup-functions.sql) both JOIN `tenants`, and both
-- are SECURITY DEFINER owned by the migration superuser -- they execute with the owner's
-- privileges and bypass RLS on every table they touch, this one included. Adding this policy does
-- not narrow them.
--
-- The alternative -- fail closed, plus a fourth SECURITY DEFINER function for tenant creation --
-- was considered and rejected as more machinery than the exposure justifies: this row holds
-- clinic directory data (name, phone, address, timezone, scheduling policy), not clinical or
-- financial records, and every one of those already leaves the building on a clinic's own
-- letterhead.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_isolation ON tenants
  USING (
    NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL
    OR id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL
    OR id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

COMMENT ON POLICY tenant_self_isolation ON tenants IS
  'D22. Inverted relative to every other tenant_isolation policy: it PERMITS an unbound session '
  'and CONSTRAINS a bound one, because creating a tenant, seeding, and cross-tenant backfills are '
  'legitimately unbound while no request-serving path ever is. A session bound to tenant A cannot '
  'read or write tenant B''s row.';

