-- Support access PR 2 (docs/SUPPORT-ACCESS.md): a session is requested by the operator or opened by an admin, approved by an
-- ACTIVE admin of that clinic, and lasts exactly one hour from approval. AccessGrant, unused and ruled shut, is dropped.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = 'tenants' AND n_live_tup > 0) THEN
    RAISE EXCEPTION 'support sessions migration: % cannot see clinics through RLS, so the emptiness check would see nothing. Run it as the migration superuser.', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM access_grants) THEN
    RAISE EXCEPTION 'support sessions migration: access_grants holds rows, which nothing was meant to write. Decide what they mean before dropping it.';
  END IF;
END $$;
DROP TABLE "access_grants";

CREATE TYPE "SupportSessionStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'DENIED', 'ENDED', 'EXPIRED');

CREATE TABLE "support_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "SupportSessionStatus" NOT NULL DEFAULT 'REQUESTED',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "ended_by" UUID,
    "end_reason" TEXT,
    "renewed_from_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_sessions_reason_present" CHECK (btrim("reason") <> ''),
    -- Approved exactly when it is or was live, and then for one hour to the microsecond.
    CONSTRAINT "support_sessions_approved_iff_live_or_was" CHECK (("status" IN ('ACTIVE', 'ENDED', 'EXPIRED')) = ("approved_at" IS NOT NULL)),
    CONSTRAINT "support_sessions_approval_complete" CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL) AND ("approved_at" IS NULL) = ("expires_at" IS NULL)),
    CONSTRAINT "support_sessions_one_hour" CHECK ("expires_at" IS NULL OR "expires_at" = "approved_at" + interval '1 hour'),
    CONSTRAINT "support_sessions_closed_with_reason" CHECK (("status" IN ('DENIED', 'ENDED', 'EXPIRED')) = ("ended_at" IS NOT NULL AND btrim(coalesce("end_reason", '')) <> ''))
);
CREATE UNIQUE INDEX "support_sessions_one_live_per_operator" ON "support_sessions"("tenant_id", "operator_id") WHERE "status" IN ('REQUESTED', 'ACTIVE');
CREATE INDEX "support_sessions_tenant_id_created_at_idx" ON "support_sessions"("tenant_id", "created_at");
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_ended_by_fkey" FOREIGN KEY ("ended_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "support_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_sessions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON support_sessions TO clinic_os_app;
CREATE TRIGGER support_sessions_audit AFTER INSERT OR UPDATE OR DELETE ON support_sessions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The database, not the code, holds the two conditions a live session rests on: the clinic's switch is on, the operator is an
-- ACTIVE platform admin, and whoever approved it is an ACTIVE OWNER or ADMIN of that clinic.
CREATE FUNCTION enforce_support_session() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('REQUESTED', 'ACTIVE') THEN
    IF NOT (SELECT support_access_enabled FROM tenants WHERE id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'support access is not enabled for this clinic' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_need_switch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.operator_id AND u.is_platform_admin AND u.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'a support session is for an active platform admin' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_operator_is_admin';
    END IF;
  END IF;
  IF NEW.status = 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD.status <> 'ACTIVE') AND NOT EXISTS (
    SELECT 1 FROM memberships m WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.approved_by AND m.status = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN')
  ) THEN
    RAISE EXCEPTION 'a support session is approved by an active admin of this clinic' USING ERRCODE = 'check_violation', CONSTRAINT = 'support_sessions_approved_by_admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER support_sessions_enforced BEFORE INSERT OR UPDATE ON support_sessions FOR EACH ROW EXECUTE FUNCTION enforce_support_session();

-- Turning the switch off ends every open session at once (PR 1's promise, kept where the sessions live). The operator's
-- session binds no tenant, so RLS would hide every row: the function runs as the definer role, granted exactly this update.
GRANT SELECT, UPDATE ON support_sessions TO clinic_os_definer;
CREATE POLICY definer_reads ON support_sessions FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_ends ON support_sessions FOR UPDATE TO clinic_os_definer USING (true) WITH CHECK (status IN ('ENDED', 'DENIED'));
CREATE FUNCTION end_support_sessions_on_switch_off() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.support_access_enabled AND NOT NEW.support_access_enabled THEN
    UPDATE support_sessions SET status = 'ENDED', ended_at = now(), end_reason = 'support access switched off'
     WHERE tenant_id = NEW.id AND status = 'ACTIVE';
    UPDATE support_sessions SET status = 'DENIED', ended_at = now(), end_reason = 'support access switched off'
     WHERE tenant_id = NEW.id AND status = 'REQUESTED';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION end_support_sessions_on_switch_off() OWNER TO clinic_os_definer;
CREATE TRIGGER tenants_support_switch_off_ends_sessions AFTER UPDATE OF support_access_enabled ON tenants
  FOR EACH ROW EXECUTE FUNCTION end_support_sessions_on_switch_off();

-- The operator's own sessions across clinics: the platform_clinic_counts() shape, and only the caller's rows.
CREATE FUNCTION platform_support_sessions()
RETURNS TABLE (id uuid, tenant_id uuid, clinic_name text, status "SupportSessionStatus", reason text, approved_at timestamptz,
               expires_at timestamptz, ended_at timestamptz, end_reason text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id uuid;
  v_is_admin boolean;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'platform_support_sessions() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.', ERRCODE = 'raise_exception';
  END IF;
  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin FROM users u WHERE u.id = v_actor_id;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_support_sessions() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT s.id, s.tenant_id, t.name, s.status, s.reason, s.approved_at, s.expires_at, s.ended_at, s.end_reason, s.created_at
    FROM support_sessions s JOIN tenants t ON t.id = s.tenant_id
   WHERE s.operator_id = v_actor_id
   ORDER BY s.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION platform_support_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_support_sessions() TO clinic_os_app;
ALTER FUNCTION platform_support_sessions() OWNER TO clinic_os_definer;
