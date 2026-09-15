-- Phase 1, Checkpoint 3 — RLS on audit_logs (SCHEMA-DECISIONS.md D17).
--
-- D15 extended RLS to 29 tables and deliberately left audit_logs out, because its tenant_id is
-- nullable and the standard policy would have made legitimately-null rows invisible to everyone.
-- D16 then made audit_logs hold to_jsonb(NEW) of every row of all 29 of those tables. The
-- exclusion that was defensible when the table held whatever a service chose to report is not
-- defensible now: it is a complete, unprotected mirror of every table the other 29 policies
-- protect. Every diagnosis, note, and prescription line in the product is in here.
--
-- The thing D15 treated as the obstacle turns out to be the answer. `tenant_id = <bound tenant>`
-- is never true for a NULL tenant_id -- that is ordinary SQL NULL semantics, not a special case --
-- so the same predicate used on the other 29 tables makes orphaned rows visible to no tenant
-- session at all. That is the correct outcome, not an accident to work around: tenant_id IS NULL
-- means the tenant is gone, and no live tenant session has any business reading its history.

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- Deliberately identical in shape to 01-constraints.sql and 03-extend-rls.sql. The append-only
-- triggers from D5 are unaffected and stay: RLS governs which rows a session may see and write,
-- the append-only trigger governs which operations exist at all. They are orthogonal, and both
-- apply.
--
-- WITH CHECK is what the audit trigger's own INSERT must satisfy. audit_row_change() is a
-- SECURITY INVOKER function -- it runs as clinic_os_app, which is NOBYPASSRLS (D12) -- so its
-- INSERT is policed exactly like any other write from the application. It passes because it
-- stamps the audit row with the *source row's* tenant_id, and the source row was itself only
-- writable because it matched the same bound session tenant. The two agree by construction, not
-- by coincidence. If they ever did not, the source write would have been rejected first.
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================================
-- Break-glass access to orphaned rows.
--
-- The policy above deliberately leaves NULL-tenant rows reachable by nobody. They still need to
-- be reachable by someone -- a regulator's question about a closed clinic, an acquirer's due
-- diligence, an incident investigation. This is that path, and it is the only one.
--
-- Same pattern as 04-membership-lookup-functions.sql, for the same reason: a narrowly-scoped
-- SECURITY DEFINER function owned by the migration superuser, rather than granting clinic_os_app
-- any broader bypass that would undo the policy above for every other query on this table.
--
-- Three properties that make this an audited door rather than a hole:
--   1. It returns ONLY rows with tenant_id IS NULL. It cannot be used to read a live tenant's
--      history -- that is what the policy above is for, and this does not overlap with it.
--   2. It refuses any caller that is not an ACTIVE platform admin. The actor is read from
--      app.current_actor_id rather than taken as a parameter, so a caller cannot name someone
--      else as the reader.
--   3. Every call writes its own BREAK_GLASS_ACCESS audit row before returning anything. Reading
--      a deleted tenant's history is itself part of the record.
-- ============================================================================

CREATE FUNCTION read_orphaned_audit_logs(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id uuid,
  actor_user_id uuid,
  actor_role text,
  action "AuditAction",
  entity_type text,
  entity_id uuid,
  previous_state jsonb,
  new_state jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_is_admin boolean;
  v_event_id uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Break-glass audit read requires a bound actor'
      USING HINT = 'Bind app.current_actor_id first -- see SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin
  FROM users u WHERE u.id = v_actor_id;

  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'Break-glass audit read refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Written before the rows are returned, not after, and in the same transaction as the read.
  -- A caller that rolls back loses the read and the record of it together; a caller that commits
  -- keeps both. There is no ordering in which the data is disclosed but the disclosure is not
  -- recorded.
  --
  -- entity_id is NOT NULL and there is no single row this access is "about", so the event row
  -- points at itself: the access event IS the entity. new_state carries what was actually asked
  -- for, which is the part an investigator will want. tenant_id is NULL because that is exactly
  -- the population being read -- and it is why this INSERT has to happen inside a SECURITY
  -- DEFINER function: the policy above would reject a NULL-tenant write from any ordinary
  -- session, correctly.
  v_event_id := uuid_generate_v7();
  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    v_event_id,
    NULL,
    v_actor_id,
    'PLATFORM_ADMIN',
    'BREAK_GLASS_ACCESS',
    'audit_logs',
    v_event_id,
    NULL,
    jsonb_build_object('scope', 'orphaned_audit_logs', 'limit', p_limit),
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN QUERY
  SELECT a.id, a.actor_user_id, a.actor_role, a.action, a.entity_type, a.entity_id,
         a.previous_state, a.new_state, a.ip_address, a.user_agent, a.created_at
  FROM audit_logs a
  WHERE a.tenant_id IS NULL
    AND a.id <> v_event_id
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION read_orphaned_audit_logs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_orphaned_audit_logs(integer) TO clinic_os_app;

COMMENT ON FUNCTION read_orphaned_audit_logs(integer) IS
  'The only path to audit_logs rows whose tenant has been deleted. Active platform admins only, '
  'and every call writes its own BREAK_GLASS_ACCESS row. See SCHEMA-DECISIONS.md D17.';
