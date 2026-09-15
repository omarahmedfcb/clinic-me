-- Phase 1, Checkpoint 3 — a direct consequence of 03-extend-rls.sql (D15): memberships is now
-- RLS-protected, and listActiveMemberships()/resolveActiveMembership() (user-lookup.ts,
-- refresh-tokens.ts) are *deliberately* cross-tenant raw queries -- discovering which tenant(s) a
-- user belongs to, before any single tenant is known, which is exactly what RLS's per-tenant
-- session variable cannot express. With RLS now enforced, those queries fail closed (empty
-- results) unconditionally, because there is no tenant to bind for a query that must not be
-- bound to one.
--
-- The correct fix is not to weaken the new policy or grant clinic_os_app BYPASSRLS somewhere
-- (that would defeat D15's entire point for every OTHER query on this table, not just these two).
-- It's a narrowly-scoped escape hatch: a SECURITY DEFINER function, owned by the migration
-- superuser, executing with the OWNER's privileges (which bypass RLS) regardless of who calls it.
-- clinic_os_app is granted EXECUTE on exactly these two functions and nothing broader -- every
-- other access to `memberships` through clinic_os_app remains fully RLS-constrained.

CREATE FUNCTION list_active_memberships_for_user(p_user_id uuid)
RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_name text, tenant_slug text, role "MembershipRole")
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.tenant_id, t.name, t.slug, m.role
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.status = 'ACTIVE'
    AND t.status = 'ACTIVE'
  ORDER BY t.name;
$$;

REVOKE ALL ON FUNCTION list_active_memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_active_memberships_for_user(uuid) TO clinic_os_app;

CREATE FUNCTION resolve_active_membership(p_user_id uuid, p_membership_id uuid)
RETURNS TABLE (membership_id uuid, tenant_id uuid, role "MembershipRole")
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.tenant_id, m.role
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
    AND m.id = p_membership_id
    AND m.status = 'ACTIVE'
    AND t.status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION resolve_active_membership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_active_membership(uuid, uuid) TO clinic_os_app;
