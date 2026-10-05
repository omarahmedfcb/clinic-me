-- One WhatsApp connection per clinic, created by Embedded Signup (Meta Tech Provider).
-- Tenant-scoped like every clinic-owned table, with a redacting audit trigger of its own.
--
-- Two credentials live here, both encrypted at rest by the application (AES-256-GCM, key in the
-- environment, never in the database): the clinic's Meta business token -- Tech Providers use
-- per-customer business tokens exclusively -- and the secret of the clinic's bot credential. The
-- bot secret cannot be recovered from `bot_credentials.secret_hash` (Argon2id, shown once), and the
-- WhatsApp pipeline is itself the HTTP client of /bot/*, so it has to keep a usable copy.

CREATE TABLE whatsapp_connections (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  waba_id              text NOT NULL,
  phone_number_id      text NOT NULL,
  business_id          text,
  display_phone_number text,
  verified_name        text,
  status               text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'TOKEN_INVALID', 'DISCONNECTED')),
  access_token_enc     text NOT NULL,
  bot_credential_id    uuid NOT NULL REFERENCES bot_credentials(id),
  bot_secret_enc       text NOT NULL,
  connected_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_at           timestamptz(6) NOT NULL DEFAULT now()
);

-- One connection per clinic, and one clinic per Meta number: the second is what makes
-- `phone_number_id` safe as the tenant-resolution key for an inbound webhook.
CREATE UNIQUE INDEX whatsapp_connections_tenant_id_key ON whatsapp_connections (tenant_id);
CREATE UNIQUE INDEX whatsapp_connections_phone_number_id_key ON whatsapp_connections (phone_number_id);

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON whatsapp_connections
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON whatsapp_connections TO clinic_os_app;

-- Audited, but not by `audit_row_change()`: that stores `to_jsonb(NEW)` whole, which would put both
-- encrypted credentials into `audit_logs`, a table the clinic's own admin can read. Same answer as
-- `audit_bot_credential_change()`: record THAT a credential changed, never the value.
CREATE OR REPLACE FUNCTION audit_whatsapp_connection_change() RETURNS trigger
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

  v_old := CASE WHEN OLD IS NULL THEN NULL ELSE (to_jsonb(OLD) - 'access_token_enc' - 'bot_secret_enc')
                  || jsonb_build_object('access_token_enc', '(redacted)', 'bot_secret_enc', '(redacted)') END;
  v_new := CASE WHEN NEW IS NULL THEN NULL ELSE (to_jsonb(NEW) - 'access_token_enc' - 'bot_secret_enc')
                  || jsonb_build_object('access_token_enc', '(redacted)', 'bot_secret_enc', '(redacted)') END;

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

-- Named `<table>_audit`, which is what audit-triggers.integration.spec.ts looks for.
CREATE TRIGGER whatsapp_connections_audit
  AFTER INSERT OR DELETE
      OR UPDATE OF status, waba_id, phone_number_id, access_token_enc, bot_credential_id, bot_secret_enc
  ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION audit_whatsapp_connection_change();

ALTER FUNCTION audit_whatsapp_connection_change() OWNER TO clinic_os_definer;

-- The inbound webhook knows only a `phone_number_id`, so this lookup has no tenant to bind: same
-- shape and same narrowness as `resolve_bot_credential` -- one SECURITY DEFINER function by a
-- unique key, and nothing wider. It returns ciphertext; only the application holds the key.
CREATE FUNCTION resolve_whatsapp_connection(p_phone_number_id text)
RETURNS TABLE (
  tenant_id uuid, waba_id text, status text,
  access_token_enc text, bot_credential_id uuid, bot_secret_enc text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.tenant_id, c.waba_id, c.status, c.access_token_enc, c.bot_credential_id, c.bot_secret_enc
  FROM whatsapp_connections c
  WHERE c.phone_number_id = p_phone_number_id;
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_connection(text) TO clinic_os_app;
ALTER FUNCTION resolve_whatsapp_connection(text) OWNER TO clinic_os_definer;
