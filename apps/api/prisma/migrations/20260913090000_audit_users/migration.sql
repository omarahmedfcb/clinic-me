-- `users` is audited like every other table — the founder's ruling, 2026-09-13.
--
-- It was deliberately excluded in `prisma/sql/07-audit-triggers.sql`, with the other cross-tenant
-- tables, because `audit_row_change()` reads `NEW.tenant_id` and a person has none. That reasoning
-- was about the mechanism and it outlived its usefulness: a name, a phone number, a photo and a
-- password reset are exactly the administrative acts an audit trail exists to record, and the users
-- screen now edits all four. Diagnosing the owner's demotion needed the date a photo was written,
-- and the only way to get it was to decode a UUIDv7 out of a storage key.
--
-- Same shape as `15-tenants-audit.sql`, which faced the same problem for the same reason.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

/*
 * **`password_hash` is redacted, not recorded.**
 *
 * `to_jsonb(OLD)` would put an Argon2 hash of a live credential into `audit_logs`, a table many
 * roles can read within their tenant. What the trail needs is that the password changed and who
 * changed it, which is what the marker carries — the hash itself is not evidence of anything.
 *
 * **`tenant_id` is whichever clinic the actor was acting in, and may be NULL.** A person is not
 * owned by a clinic: an admin editing a colleague's phone is acting inside their tenant, while a
 * platform-level change (a script, a future self-service screen) has no tenant bound. NULL is the
 * honest answer there, and `audit_logs.tenant_id` is nullable. Note the consequence: a NULL-tenant
 * row is invisible to the per-tenant RLS read, so it is a platform record rather than a clinic's.
 *
 * **UPDATE only**, exactly as `tenants` is. Creating a user happens at registration and in the seed,
 * where no actor is bound by construction, so an INSERT trigger would make account creation
 * impossible; deletion happens from scripts outside any session.
 */
CREATE OR REPLACE FUNCTION audit_user_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_old        jsonb;
  v_new        jsonb;
BEGIN
  -- **A login timestamp is not an administrative act, and login is structurally unbound.**
  -- `auth.controller.ts` stamps `last_login_at` after verifying credentials, before any session
  -- exists to bind an actor to. Requiring one here would make logging in impossible — so an update
  -- that touches nothing but that column (and the `updated_at` Prisma sets with it) is exempt, and
  -- writes no row. Every other change to a person goes through a caller that has an actor.
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

  v_old := to_jsonb(OLD) - 'password_hash';
  v_new := to_jsonb(NEW) - 'password_hash';
  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    v_old := v_old || jsonb_build_object('password_hash', '(redacted: unchanged value not recorded)');
    v_new := v_new || jsonb_build_object('password_hash', '(redacted: changed)');
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

-- Named `users_audit` to match the convention the conformance test derives its expectation from.
CREATE TRIGGER users_audit
  AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_user_change();

SELECT set_config('app.current_actor_id', '', false);
