-- The WhatsApp bot's per-clinic credential. docs/WHATSAPP-BOT-CONTRACT.md §2.
-- Tenant-scoped like every clinic-owned table, and audited by the same trigger as the rest.

CREATE TABLE bot_credentials (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  membership_id      uuid NOT NULL REFERENCES memberships(id),
  secret_hash        text NOT NULL,
  issued_by_user_id  uuid NOT NULL REFERENCES users(id),
  issued_at          timestamptz(6) NOT NULL DEFAULT now(),
  revoked_at         timestamptz(6),
  revoked_by_user_id uuid REFERENCES users(id),
  last_used_at       timestamptz(6),
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_at         timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX bot_credentials_tenant_id_idx ON bot_credentials (tenant_id);

-- **One live credential per clinic**, as a partial unique index rather than a service check.
-- Two administrators issuing at the same moment is the case a check-then-insert loses, and a clinic
-- with two live bot credentials is one whose revocation does not mean what it says.
CREATE UNIQUE INDEX bot_credentials_one_active_per_tenant
  ON bot_credentials (tenant_id)
  WHERE revoked_at IS NULL;

-- Row-level security, in the shape every tenant-scoped table here uses: the policy is the isolation,
-- and FORCE applies it to the table's owner too.
ALTER TABLE bot_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bot_credentials
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON bot_credentials TO clinic_os_app;

-- Audited, but NOT by `audit_row_change()`.
--
-- That function stores `to_jsonb(NEW)` whole, which would put `secret_hash` into `audit_logs` — a
-- table built to be read, and readable by the clinic's own admin on the audit screen. An argon2
-- hash is not the credential and cannot be reversed into it, so this is a smaller leak than the
-- TOTP one of 2026-09-16; it is still a credential column sitting in a log, and the same answer
-- applies: record THAT it changed, never the value. The explicit column list follows
-- `audit_user_change()`, and for the reason stated there — adding a secret column should be a
-- visible edit to this function rather than something a pattern silently covers or misses.
CREATE OR REPLACE FUNCTION audit_bot_credential_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_old        jsonb;
  v_new        jsonb;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first; application code does this via withTenant().',
            ERRCODE = 'raise_exception';
  END IF;

  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);

  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id AND m.user_id = v_actor_id AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  v_old := CASE WHEN OLD IS NULL THEN NULL ELSE (to_jsonb(OLD) - 'secret_hash')
                  || jsonb_build_object('secret_hash', '(redacted)') END;
  v_new := CASE WHEN NEW IS NULL THEN NULL ELSE (to_jsonb(NEW) - 'secret_hash')
                  || jsonb_build_object('secret_hash', '(redacted)') END;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END::"AuditAction",
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    v_old,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- `last_used_at` is deliberately outside the trigger's column list: it changes on every call the bot
-- makes, and auditing that would bury the two acts that matter — issuing and revoking — under a
-- row per request.
CREATE TRIGGER bot_credentials_audit
  AFTER INSERT OR DELETE
      OR UPDATE OF secret_hash, membership_id, revoked_at, revoked_by_user_id
  ON bot_credentials
  FOR EACH ROW EXECUTE FUNCTION audit_bot_credential_change();

-- Owned by clinic_os_definer, like every other SECURITY DEFINER helper: a managed PostgreSQL has no
-- superuser, and FORCE RLS would otherwise stop this trigger writing the row it exists to write.
-- scripts/rls-ownership-drill.mjs refuses the schema if this is forgotten.
ALTER FUNCTION audit_bot_credential_change() OWNER TO clinic_os_definer;

-- Authenticating the bot is inherently unbound: the credential is what says which clinic it belongs
-- to, so there is no tenant to bind before the lookup that answers that. Same answer as
-- `resolve_active_membership` (prisma/sql/04): one SECURITY DEFINER function by primary key, and
-- nothing wider — a query that filtered on anything else would be a way to enumerate clinics.
CREATE FUNCTION resolve_bot_credential(p_credential_id uuid)
RETURNS TABLE (
  credential_id uuid, tenant_id uuid, membership_id uuid, user_id uuid,
  secret_hash text, revoked_at timestamptz, membership_status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.tenant_id, c.membership_id, m.user_id, c.secret_hash, c.revoked_at, m.status::text
  FROM bot_credentials c
  JOIN memberships m ON m.id = c.membership_id
  WHERE c.id = p_credential_id;
$$;

REVOKE ALL ON FUNCTION resolve_bot_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_bot_credential(uuid) TO clinic_os_app;

-- Stamped only after the secret verified, so `last_used_at` means "used", not "attempted". Returns
-- the stamp rather than `void`, which the Prisma driver has no type mapping for.
CREATE FUNCTION note_bot_credential_use(p_credential_id uuid, p_at timestamptz) RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE bot_credentials
  SET last_used_at = p_at, updated_at = p_at
  WHERE id = p_credential_id AND revoked_at IS NULL
  RETURNING last_used_at;
$$;

REVOKE ALL ON FUNCTION note_bot_credential_use(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION note_bot_credential_use(uuid, timestamptz) TO clinic_os_app;

-- What those two bodies touch, and nothing else. The definer role is NOBYPASSRLS on purpose, so the
-- policies are what let it read and stamp the one row — a managed PostgreSQL has no superuser to
-- fall back on (see 20260918080000_definer_role_portability).
GRANT SELECT, UPDATE ON bot_credentials TO clinic_os_definer;

CREATE POLICY definer_reads ON bot_credentials FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_stamps_use ON bot_credentials FOR UPDATE TO clinic_os_definer
  USING (revoked_at IS NULL) WITH CHECK (revoked_at IS NULL);

ALTER FUNCTION resolve_bot_credential(uuid) OWNER TO clinic_os_definer;
ALTER FUNCTION note_bot_credential_use(uuid, timestamptz) OWNER TO clinic_os_definer;
