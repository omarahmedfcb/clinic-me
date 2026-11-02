-- Support access PR 3 (docs/SUPPORT-ACCESS.md): the support token is checked on every request against the live session,
-- and the audit trigger, which runs on every write, refuses one made under a session that is no longer live.

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_entity_id  uuid;
  v_action     "AuditAction";
  v_previous   jsonb;
  v_new        jsonb;
  v_row        jsonb;
  v_branch_id  uuid;
  v_support    uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. Application code does this via withTenant(); '
                   'an unattended process should bind system_actor_id(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  -- The third expiry layer: under a support session, no write lands unless that session is live now (clock, not tx start).
  v_support := NULLIF(current_setting('app.current_support_session_id', true), '')::uuid;
  IF v_support IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM support_sessions s WHERE s.id = v_support AND s.status = 'ACTIVE' AND s.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'support session % is not live: no write is allowed under it', v_support
      USING ERRCODE = 'check_violation', CONSTRAINT = 'support_session_live';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action    := 'CREATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := NULL;
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action    := 'UPDATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
  ELSE
    v_action    := 'DELETE';
    v_tenant_id := OLD.tenant_id;
    v_entity_id := OLD.id;
    v_previous  := to_jsonb(OLD);
    v_new       := NULL;
  END IF;

  v_row := COALESCE(v_new, v_previous);
  IF v_row ? 'branch_id' THEN
    v_branch_id := NULLIF(v_row->>'branch_id', '')::uuid;
  ELSE
    v_branch_id := CASE TG_TABLE_NAME
      WHEN 'appointment_events'  THEN (SELECT branch_id FROM appointments       WHERE id = (v_row->>'appointment_id')::uuid)
      WHEN 'visit_revisions'     THEN (SELECT branch_id FROM visits             WHERE id = (v_row->>'visit_id')::uuid)
      WHEN 'visit_procedures'    THEN (SELECT branch_id FROM visits             WHERE id = (v_row->>'visit_id')::uuid)
      WHEN 'visit_charge_lines'  THEN (SELECT branch_id FROM visit_charges      WHERE id = (v_row->>'charge_id')::uuid)
      WHEN 'payment_adjustments' THEN (SELECT branch_id FROM payments           WHERE id = (v_row->>'payment_id')::uuid)
      WHEN 'schedule_breaks'     THEN (SELECT branch_id FROM schedule_templates WHERE id = (v_row->>'schedule_template_id')::uuid)
      WHEN 'branches'            THEN (v_row->>'id')::uuid
    END;
    v_branch_id := COALESCE(v_branch_id, NULLIF(current_setting('app.current_branch_id', true), '')::uuid);
  END IF;

  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id
    AND m.user_id = v_actor_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at, branch_id, scope
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    v_action,
    TG_TABLE_NAME,
    v_entity_id,
    v_previous,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now(),
    v_branch_id,
    CASE WHEN v_branch_id IS NULL THEN 'UNSCOPED' ELSE 'ONE_BRANCH' END::"AuditScope"
  );

  RETURN NULL;
END;
$$;

-- The per-request layer: the session is ACTIVE with at least p_margin_seconds left, the switch is on, the operator is still an
-- active platform admin, and the token's membership is still the approver's, ACTIVE, OWNER or ADMIN. Definer-owned, because
-- the guard runs before any tenant is bound.
CREATE FUNCTION resolve_live_support_session(p_session uuid, p_operator uuid, p_membership uuid, p_margin_seconds integer)
RETURNS TABLE (tenant_id uuid, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT s.tenant_id, m.role::text, s.expires_at
    FROM support_sessions s
    JOIN tenants t ON t.id = s.tenant_id AND t.support_access_enabled
    JOIN users u ON u.id = s.operator_id AND u.is_platform_admin AND u.status = 'ACTIVE'
    JOIN memberships m ON m.id = p_membership AND m.tenant_id = s.tenant_id AND m.user_id = s.approved_by
                      AND m.status = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN')
   WHERE s.id = p_session AND s.operator_id = p_operator AND s.status = 'ACTIVE'
     AND s.expires_at > clock_timestamp() + make_interval(secs => p_margin_seconds);
$fn$;
REVOKE ALL ON FUNCTION resolve_live_support_session(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_live_support_session(uuid, uuid, uuid, integer) TO clinic_os_app;
ALTER FUNCTION resolve_live_support_session(uuid, uuid, uuid, integer) OWNER TO clinic_os_definer;
