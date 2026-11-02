-- Support access PR 4 (docs/SUPPORT-ACCESS.md): every audit row written under a support session names the operator and the
-- approving admin, and every request the operator makes is recorded, reads included, up to 300; the 301st ends the session.

ALTER TABLE "audit_logs" ADD COLUMN "support_session_id" UUID, ADD COLUMN "support_approver_id" UUID;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_support_both_identities"
  CHECK (("support_session_id" IS NULL) = ("support_approver_id" IS NULL));
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_support_role"
  CHECK (("actor_role" = 'SUPPORT') = ("support_session_id" IS NOT NULL));
CREATE INDEX "audit_logs_support_session_id_idx" ON "audit_logs"("support_session_id") WHERE "support_session_id" IS NOT NULL;

CREATE FUNCTION stamp_support_identities() RETURNS trigger
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
CREATE TRIGGER audit_logs_support_identities BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION stamp_support_identities();

CREATE TABLE "support_session_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_session_requests_pkey" PRIMARY KEY ("id"),
    -- The cap is the database's: a 301st row cannot exist, whatever the code does.
    CONSTRAINT "support_session_requests_cap" CHECK ("seq" BETWEEN 1 AND 300)
);
CREATE UNIQUE INDEX "support_session_requests_session_id_seq_key" ON "support_session_requests"("session_id", "seq");
CREATE INDEX "support_session_requests_tenant_id_created_at_idx" ON "support_session_requests"("tenant_id", "created_at");
ALTER TABLE "support_session_requests" ADD CONSTRAINT "support_session_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_session_requests" ADD CONSTRAINT "support_session_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "support_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE support_session_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_session_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_session_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT ON support_session_requests TO clinic_os_app;
GRANT SELECT, INSERT ON support_session_requests TO clinic_os_definer;
CREATE POLICY definer_reads ON support_session_requests FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_records ON support_session_requests FOR INSERT TO clinic_os_definer WITH CHECK (true);
CREATE TRIGGER support_session_requests_append_only
  BEFORE UPDATE OR DELETE ON support_session_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The per-request layer, now also the record: the session row is locked so concurrent requests count in order, the PR 3 checks
-- run under the lock, and the request is written as the next of at most 300. The 301st ends the session, by the system, saying why.
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
