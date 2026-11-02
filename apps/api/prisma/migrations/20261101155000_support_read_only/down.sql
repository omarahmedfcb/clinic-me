-- Reverses 20261101155000_support_read_only: stamp_support_identities() and record_support_request() exactly as
-- 20261101120000_support_request_trail left them. Any session's "allow changes" is dropped with its columns.
DROP FUNCTION expire_support_sessions(uuid, timestamptz);
DROP FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text);
CREATE FUNCTION record_support_request(p_session uuid, p_operator uuid, p_membership uuid, p_margin_seconds integer,
                                       p_method text, p_path text)
RETURNS TABLE (tenant_id uuid, role text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_tenant uuid;
  v_role   text;
  v_seq    integer;
BEGIN
  PERFORM 1 FROM support_sessions s WHERE s.id = p_session FOR UPDATE;
  SELECT r.tenant_id, r.role INTO v_tenant, v_role
    FROM resolve_live_support_session(p_session, p_operator, p_membership, p_margin_seconds) r;
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)::integer + 1 INTO v_seq FROM support_session_requests q WHERE q.session_id = p_session;
  IF v_seq > 300 THEN
    PERFORM set_config('app.current_actor_id', system_actor_id()::text, true);
    UPDATE support_sessions SET status = 'ENDED', ended_at = now(), end_reason = 'request cap reached: 300 requests'
     WHERE id = p_session AND status = 'ACTIVE';
    RETURN;
  END IF;

  INSERT INTO support_session_requests (id, tenant_id, session_id, seq, method, path)
  VALUES (uuid_generate_v7(), v_tenant, p_session, v_seq, p_method, left(p_path, 2000));
  RETURN QUERY SELECT v_tenant, v_role;
END;
$fn$;
REVOKE ALL ON FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) TO clinic_os_app;
ALTER FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) OWNER TO clinic_os_definer;

CREATE OR REPLACE FUNCTION stamp_support_identities() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_support  uuid;
  v_approver uuid;
BEGIN
  v_support := NULLIF(current_setting('app.current_support_session_id', true), '')::uuid;
  IF v_support IS NULL THEN
    NEW.support_session_id := NULL;
    NEW.support_approver_id := NULL;
    RETURN NEW;
  END IF;
  SELECT s.approved_by INTO v_approver FROM support_sessions s WHERE s.id = v_support;
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'support session % has no approver this session can see: refusing an audit row without both identities', v_support
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_logs_support_both_identities';
  END IF;
  NEW.actor_role := 'SUPPORT';
  NEW.support_session_id := v_support;
  NEW.support_approver_id := v_approver;
  RETURN NEW;
END;
$$;

DROP TRIGGER support_sessions_changes_allowed ON support_sessions;
DROP FUNCTION guard_support_changes_allowed();
ALTER TABLE support_sessions DROP CONSTRAINT support_sessions_changes_allowed_by_approver, DROP CONSTRAINT support_sessions_changes_allowed_complete,
  DROP CONSTRAINT support_sessions_changes_allowed_by_fkey, DROP COLUMN changes_allowed_by, DROP COLUMN changes_allowed_at;

DELETE FROM _prisma_migrations WHERE migration_name = '20261101155000_support_read_only';
