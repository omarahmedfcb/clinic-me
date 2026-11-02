-- Support access PR 5a (docs/SUPPORT-ACCESS.md): a support session is read-only until the admin who approved it records "allow
-- changes", once, for the rest of that session. The database refuses every audited write under a session that has not.

ALTER TABLE "support_sessions" ADD COLUMN "changes_allowed_at" TIMESTAMPTZ(6), ADD COLUMN "changes_allowed_by" UUID;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_changes_allowed_by_fkey" FOREIGN KEY ("changes_allowed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_changes_allowed_complete" CHECK (("changes_allowed_at" IS NULL) = ("changes_allowed_by" IS NULL));
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_changes_allowed_by_approver" CHECK ("changes_allowed_by" IS NULL OR "changes_allowed_by" = "approved_by");

CREATE FUNCTION guard_support_changes_allowed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.changes_allowed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a support session starts read-only' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_start_read_only';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.changes_allowed_at IS NOT NULL
     AND (NEW.changes_allowed_at IS DISTINCT FROM OLD.changes_allowed_at OR NEW.changes_allowed_by IS DISTINCT FROM OLD.changes_allowed_by) THEN
    RAISE EXCEPTION 'allowing changes is recorded once and never withdrawn' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_changes_allowed_once';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.changes_allowed_at IS NULL AND NEW.changes_allowed_at IS NOT NULL
     AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'changes are allowed only on a live session' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_changes_allowed_live';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER support_sessions_changes_allowed BEFORE INSERT OR UPDATE ON support_sessions FOR EACH ROW EXECUTE FUNCTION guard_support_changes_allowed();

CREATE OR REPLACE FUNCTION stamp_support_identities() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_support  uuid;
  v_approver uuid;
  v_allowed  timestamptz;
BEGIN
  v_support := NULLIF(current_setting('app.current_support_session_id', true), '')::uuid;
  IF v_support IS NULL THEN
    NEW.support_session_id := NULL;
    NEW.support_approver_id := NULL;
    RETURN NEW;
  END IF;
  SELECT s.approved_by, s.changes_allowed_at INTO v_approver, v_allowed FROM support_sessions s WHERE s.id = v_support;
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'support session % has no approver this session can see: refusing an audit row without both identities', v_support
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_logs_support_both_identities';
  END IF;
  IF NEW.action IN ('CREATE', 'UPDATE', 'DELETE') AND v_allowed IS NULL THEN
    RAISE EXCEPTION 'support session % is read-only: the approving admin has not allowed changes', v_support
      USING ERRCODE = 'check_violation', CONSTRAINT = 'support_session_read_only';
  END IF;
  NEW.actor_role := 'SUPPORT';
  NEW.support_session_id := v_support;
  NEW.support_approver_id := v_approver;
  RETURN NEW;
END;
$$;

-- The hour's housekeeping is the system's, never the support session's: both bindings are swapped for the update and restored.
CREATE FUNCTION expire_support_sessions(p_tenant uuid, p_now timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_support text := current_setting('app.current_support_session_id', true);
  v_actor   text := current_setting('app.current_actor_id', true);
BEGIN
  PERFORM set_config('app.current_support_session_id', '', true), set_config('app.current_actor_id', system_actor_id()::text, true);
  UPDATE support_sessions SET status = 'EXPIRED', ended_at = expires_at, end_reason = 'the hour ended'
   WHERE tenant_id = p_tenant AND status = 'ACTIVE' AND expires_at <= p_now;
  PERFORM set_config('app.current_support_session_id', coalesce(v_support, ''), true), set_config('app.current_actor_id', coalesce(v_actor, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION expire_support_sessions(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_support_sessions(uuid, timestamptz) TO clinic_os_app;

DROP FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text);
CREATE FUNCTION record_support_request(p_session uuid, p_operator uuid, p_membership uuid, p_margin_seconds integer,
                                       p_method text, p_path text)
RETURNS TABLE (tenant_id uuid, role text, changes_allowed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_tenant  uuid;
  v_role    text;
  v_seq     integer;
  v_allowed boolean;
BEGIN
  SELECT s.changes_allowed_at IS NOT NULL INTO v_allowed FROM support_sessions s WHERE s.id = p_session FOR UPDATE;
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
  RETURN QUERY SELECT v_tenant, v_role, v_allowed;
END;
$fn$;
REVOKE ALL ON FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) TO clinic_os_app;
ALTER FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text) OWNER TO clinic_os_definer;
