-- The users audit trigger wrote the authenticator secret into audit_logs in plaintext.
--
-- `audit_user_change()` has redacted `password_hash` since 2026-09-13 and nothing else. When the
-- platform console added `totp_secret` (2026-09-14), every update to an operator's row began
-- recording the shared secret of their second factor in `new_state` — in full, in a table built to
-- be read. A hash that cannot be reversed and a secret that is the credential itself are not the
-- same kind of value, and only the first was being handled.
--
-- Found on 2026-09-16 while asserting a different audit row, in the JSON of a passing test.
--
-- Redacts the same way `password_hash` is: the row still records THAT the factor changed, which is
-- the audit-worthy fact, and never what it changed to. Existing rows are not rewritten — audit_logs
-- is append-only by trigger (D5) and rewriting history to hide a leak is worse than the leak. The
-- secrets already recorded are in `clinic_os_dev` and `clinic_os_test` only; any operator enrolled
-- against a real deployment should replace their authenticator, which the console can now do.

CREATE OR REPLACE FUNCTION audit_user_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id   uuid;
  v_tenant_id  uuid;
  v_actor_role text;
  v_old        jsonb;
  v_new        jsonb;
BEGIN
  IF to_jsonb(OLD) - 'last_login_at' - 'updated_at' = to_jsonb(NEW) - 'last_login_at' - 'updated_at' THEN
    RETURN NULL;
  END IF;

  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. Application code does this via withTenant(); '
                   'an unattended process should bind system_actor_id(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  v_tenant_id := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;

  IF v_tenant_id IS NOT NULL THEN
    SELECT m.role::text INTO v_actor_role
    FROM memberships m
    WHERE m.tenant_id = v_tenant_id
      AND m.user_id = v_actor_id
      AND m.status = 'ACTIVE'
    LIMIT 1;
  END IF;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  -- Every credential column, stripped first and named back only as "changed" or "unchanged". The
  -- list is explicit rather than a pattern so that adding a secret column is a visible edit here.
  v_old := to_jsonb(OLD) - 'password_hash' - 'totp_secret' - 'totp_pending_secret';
  v_new := to_jsonb(NEW) - 'password_hash' - 'totp_secret' - 'totp_pending_secret';

  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    v_old := v_old || jsonb_build_object('password_hash', '(redacted: unchanged value not recorded)');
    v_new := v_new || jsonb_build_object('password_hash', '(redacted: changed)');
  END IF;

  -- Whether a second factor EXISTS is not a secret and is worth auditing; its value is.
  IF OLD.totp_secret IS DISTINCT FROM NEW.totp_secret THEN
    v_old := v_old || jsonb_build_object(
      'totp_secret',
      CASE WHEN OLD.totp_secret IS NULL THEN '(none)' ELSE '(redacted: replaced)' END);
    v_new := v_new || jsonb_build_object(
      'totp_secret',
      CASE WHEN NEW.totp_secret IS NULL THEN '(cleared)' ELSE '(redacted: set)' END);
  END IF;

  IF OLD.totp_pending_secret IS DISTINCT FROM NEW.totp_pending_secret THEN
    v_new := v_new || jsonb_build_object(
      'totp_pending_secret',
      CASE WHEN NEW.totp_pending_secret IS NULL THEN '(cleared)' ELSE '(redacted: set)' END);
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    'UPDATE',
    TG_TABLE_NAME,
    NEW.id,
    v_old,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NULL;
END;
$$;
