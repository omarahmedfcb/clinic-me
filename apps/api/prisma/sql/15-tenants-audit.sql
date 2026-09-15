-- Phase 2 — SCHEMA-DECISIONS.md D22, second half.
--
-- Split from 14-tenants-rls.sql rather than appended to it: 14 had already been applied to the
-- dev and test databases, and Prisma records a checksum of each applied migration. Editing one
-- in place makes every later `migrate deploy` report drift on a machine that already ran it.
-- Migrations are append-only in practice even when nothing enforces it.
-- ============================================================================
-- AUDITING CLINIC SETTINGS — A CONSEQUENCE OF THE POLICY ABOVE
-- ============================================================================
--
-- `audit-triggers.integration.spec.ts` derives its expectation structurally: every table with RLS
-- must carry a `<table>_audit` trigger. Enabling RLS above therefore made that test fail, which is
-- the conformance check doing exactly its job -- it noticed a decision being made by omission.
--
-- The right answer is to audit this table, not to add an exception. `tenants` holds the clinic's
-- name, phone, address, timezone, currency, status and -- since Phase 2 -- its scheduling policy.
-- Changing `no_show_grace_minutes` changes when patients are marked absent; changing `status`
-- suspends a clinic. Those are precisely the administrative acts §8 restricts to OWNER and ADMIN
-- and that an audit trail exists to record.
--
--
-- WHY A SEPARATE FUNCTION
--
-- `audit_row_change()` reads `NEW.tenant_id`, which this table does not have -- it *is* the
-- tenant. A record with no such field raises at runtime, so the shared function cannot be attached
-- here. This one is the same logic with `NEW.id` as the tenant id, and nothing else changed.
--
--
-- WHY UPDATE ONLY, AND NOT INSERT OR DELETE
--
-- The audit trigger refuses any write with no actor bound (D16), deliberately and without
-- degrading. Creating a tenant is structurally unbound -- there is no tenant to bind before the
-- row exists -- so an INSERT trigger would make tenant creation impossible for the seed, the test
-- fixtures, and whatever eventually provisions a real clinic. Deletion is the same: it happens
-- from outside any tenant session.
--
-- An UPDATE never is. Every path that changes a clinic's settings runs inside `withTenant()`, so
-- the actor is always bound and the trail is complete for the operation that actually matters.
-- Creating and deleting a clinic are platform-level acts performed by a script, and belong to
-- whatever audit that script keeps -- not to a trigger that would block them.

CREATE OR REPLACE FUNCTION audit_tenant_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. Application code does this via withTenant(); '
                   'an unattended process should bind system_actor_id(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = NEW.id
    AND m.user_id = v_actor_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    NEW.id,
    v_actor_id,
    v_actor_role,
    'UPDATE',
    TG_TABLE_NAME,
    NEW.id,
    to_jsonb(OLD),
    to_jsonb(NEW),
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NULL;
END;
$$;

-- Named `tenants_audit` to match the convention the conformance test derives its expectation from.
CREATE TRIGGER tenants_audit
  AFTER UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION audit_tenant_change();
