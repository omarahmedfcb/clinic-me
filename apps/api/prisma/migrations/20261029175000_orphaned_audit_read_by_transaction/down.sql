-- Reverses 20261029175000_orphaned_audit_read_by_transaction: rows again, newest first by id.
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
  SELECT a.id, a.actor_user_id, a.actor_role, a.action, a.entity_type, a.entity_id,
         a.previous_state, a.new_state, a.ip_address, a.user_agent, a.created_at
  FROM audit_logs a
  WHERE a.tenant_id IS NULL
    AND a.id <> v_event_id
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT p_limit;
END;
$$;

DELETE FROM _prisma_migrations WHERE migration_name = '20261029175000_orphaned_audit_read_by_transaction';
