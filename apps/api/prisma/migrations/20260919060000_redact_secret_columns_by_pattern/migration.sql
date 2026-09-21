-- `audit_user_change()` redacts by pattern, not by a list somebody has to remember to extend.

-- ============================================================================
-- Why the list became a pattern
--
-- The list was explicit on purpose, and the note beside it said so: "adding a secret column should
-- be a visible edit here". That argument lost to the evidence. `totp_secret` arrived on 2026-09-14
-- and was written into `audit_logs` in full for two days before anyone noticed, in the JSON of a
-- passing test — the edit the list was supposed to force did not happen, because nobody adding a
-- column goes looking for a trigger that mentions three other columns by name.
--
-- A pattern fails in the safe direction. A column named `*_secret`, `*_hash` or `*_pending_secret`
-- is redacted the moment it exists, and the cost of a false positive — a content hash redacted in
-- an audit row nobody was reading it from — is a line of prose, while the cost of a false negative
-- is a credential in a table built to be read.
--
-- What the row still records is what it always recorded: THAT the value changed, and whether it was
-- set, replaced or cleared. Only the value is gone, and it is gone generically.
-- ============================================================================

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
  v_column     text;
  v_had_old    boolean;
  v_has_new    boolean;
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

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  -- Every column whose name says it holds a credential, whether or not anybody edited this function
  -- when they added it. Derived from the row itself, so a column added tomorrow is covered today.
  FOR v_column IN SELECT jsonb_object_keys(v_new) LOOP
    CONTINUE WHEN v_column NOT LIKE '%\_secret' AND v_column NOT LIKE '%\_hash'
              AND v_column NOT LIKE '%\_pending\_secret';

    -- Read before either side is rewritten: the rewrite below replaces the value with a label, and
    -- a CASE that then asked "was the old one null?" would be reading its own output.
    v_had_old := v_old -> v_column IS DISTINCT FROM 'null'::jsonb;
    v_has_new := v_new -> v_column IS DISTINCT FROM 'null'::jsonb;

    IF v_old -> v_column IS DISTINCT FROM v_new -> v_column THEN
      v_old := jsonb_set(v_old, ARRAY[v_column], to_jsonb(
        CASE WHEN v_had_old THEN '(redacted: replaced)' ELSE '(none)' END));
      -- "set" and "changed" are different facts: one is a credential that did not exist before, the
      -- other is one that did. Both were in the wording the explicit list used, and both survive.
      v_new := jsonb_set(v_new, ARRAY[v_column], to_jsonb(
        CASE
          WHEN NOT v_has_new THEN '(cleared)'
          WHEN NOT v_had_old THEN '(redacted: set)'
          ELSE '(redacted: changed)'
        END));
    ELSE
      -- Unchanged, and still never written out: an audit row is not a place to read a secret from
      -- just because this particular update did not touch it.
      v_old := jsonb_set(v_old, ARRAY[v_column], to_jsonb(
        CASE WHEN v_had_old THEN '(redacted: unchanged)' ELSE '(none)' END));
      v_new := jsonb_set(v_new, ARRAY[v_column], to_jsonb(
        CASE WHEN v_has_new THEN '(redacted: unchanged)' ELSE '(none)' END));
    END IF;
  END LOOP;

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

ALTER FUNCTION audit_user_change() OWNER TO clinic_os_definer;
