-- The break-glass read returns whole transactions, newest first: p_limit counts transactions, and the
-- rows inside one carry no order (ruled 2026-10-29), so they list by entity and action, never by id.
CREATE OR REPLACE FUNCTION read_orphaned_audit_logs(p_limit integer DEFAULT 100)
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
  WITH events AS (
    SELECT o.actor_user_id, o.created_at
      FROM audit_logs o
     WHERE o.tenant_id IS NULL AND o.id <> v_event_id
     GROUP BY o.actor_user_id, o.created_at
     ORDER BY o.created_at DESC, o.actor_user_id
     LIMIT p_limit
  )
  SELECT a.id, a.actor_user_id, a.actor_role, a.action, a.entity_type, a.entity_id,
         a.previous_state, a.new_state, a.ip_address, a.user_agent, a.created_at
  FROM audit_logs a
  JOIN events e ON e.actor_user_id = a.actor_user_id AND e.created_at = a.created_at
  WHERE a.tenant_id IS NULL
    AND a.id <> v_event_id
  ORDER BY a.created_at DESC, a.actor_user_id, a.entity_type, a.action::text, a.entity_id, a.id;
END;
$$;
